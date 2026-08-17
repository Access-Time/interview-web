import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Option, Stream } from "effect";
import { Ffmpeg } from "./ffmpeg.ts";
import { finalizeJob } from "./finalize.ts";
import { JobStore } from "./job-store.ts";

const jobPattern =
  /^\/jobs\/([A-Za-z0-9_-]{1,128})(?:\/parts\/(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)|\/(finalize|output))?$/;
const checksumPattern = /^[a-f\d]{64}$/i;
const mediaTypes = new Set(["video/webm", "video/mp4"]);
const maxPartBytes = 512 * 1024 * 1024;
const maxJsonBytes = 2 * 1024 * 1024;
const sealing = new Set<string>();

const json = (status: number, value: unknown) =>
  HttpServerResponse.unsafeJson(value, { status });
const errorStatus = (error: unknown) => {
  if (error instanceof Error && error.message === "request too large") {
    return 413;
  }
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "PartsPlanMismatch":
      case "JobNotOpen":
      case "PartAlreadyDiffers":
        return 409;
      case "InputTooLarge":
        return 413;
      case "FfmpegFailed":
      case "NoMediaStream":
        return 422;
      default:
        return 500;
    }
  }
  return 500;
};
const message = (error: unknown) =>
  typeof error === "object" && error !== null && "message" in error
    ? String(error.message)
    : "internal error";

const body = (request: HttpServerRequest.HttpServerRequest, limit: number) =>
  Stream.runFoldEffect(
    request.stream,
    { chunks: [] as Uint8Array[], size: 0 },
    (state, chunk) => {
      const size = state.size + chunk.byteLength;
      if (size > limit) {
        return Effect.fail(new Error("request too large"));
      }
      state.chunks.push(chunk);
      state.size = size;
      return Effect.succeed(state);
    }
  ).pipe(Effect.map(({ chunks }) => Buffer.concat(chunks)));

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: this is the protocol dispatcher.
const route = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const store = yield* JobStore;
  yield* Ffmpeg;
  const url = new URL(request.url, "http://localhost");
  if (request.method === "GET" && url.pathname === "/health") {
    return HttpServerResponse.empty({ status: 204 });
  }
  const match = jobPattern.exec(url.pathname);
  if (!match) {
    return json(404, { error: "not found" });
  }
  const job = decodeURIComponent(match[1] as string);
  if (request.method === "DELETE" && !match[2] && !match[4]) {
    yield* store.deleteJob(job);
    sealing.delete(job);
    return HttpServerResponse.empty({ status: 204 });
  }
  if (request.method === "PUT" && match[2] !== undefined) {
    if (sealing.has(job)) {
      return json(409, { error: "job is sealing" });
    }
    const checksum = request.headers["x-content-sha256"];
    if (!(checksum && checksumPattern.test(checksum))) {
      return json(400, { error: "invalid checksum" });
    }
    const declaredLength =
      request.headers["content-length"] === undefined
        ? undefined
        : Number(request.headers["content-length"]);
    if (
      declaredLength !== undefined &&
      (!Number.isSafeInteger(declaredLength) ||
        declaredLength < 0 ||
        declaredLength > maxPartBytes)
    ) {
      return json(413, { error: "part too large" });
    }
    const bytes = yield* body(request, maxPartBytes);
    if (
      request.headers["content-length"] !== undefined &&
      Number(request.headers["content-length"]) !== bytes.byteLength
    ) {
      return json(400, { error: "content length mismatch" });
    }
    const actual = createHash("sha256").update(bytes).digest("hex");
    if (actual !== checksum.toLowerCase()) {
      return json(400, { error: "checksum mismatch" });
    }
    const partName = `part-${Number(match[2])}-${Number(match[3])}.bin`;
    const existed = (yield* store.listParts(job)).includes(partName);
    yield* store.putPart({
      bytes,
      checksum: actual,
      job,
      segment: Number(match[2]),
      sequence: Number(match[3]),
    });
    return json(
      existed ? 200 : 201,
      existed ? { idempotent: true } : { accepted: true }
    );
  }
  if (request.method === "POST" && match[4] === "finalize") {
    if (sealing.has(job)) {
      return json(409, { error: "job is not open" });
    }
    const jsonBytes = yield* body(request, maxJsonBytes);
    let data: unknown;
    try {
      data = JSON.parse(new TextDecoder().decode(jsonBytes));
    } catch {
      return json(400, { error: "invalid JSON" });
    }
    if (
      !data ||
      typeof data !== "object" ||
      !Array.isArray((data as { segments?: unknown }).segments) ||
      !mediaTypes.has(
        (data as { outputMediaType?: string }).outputMediaType ?? ""
      )
    ) {
      return json(400, { error: "invalid finalize request" });
    }
    const finalizeData = data as {
      outputMediaType: "video/webm" | "video/mp4";
      segments: ReadonlyArray<{ partIndexes: number[]; segmentIndex: number }>;
    };
    if (
      finalizeData.segments.length === 0 ||
      finalizeData.segments.length > 20
    ) {
      return json(400, { error: "invalid finalize request" });
    }
    for (const [index, segment] of finalizeData.segments.entries()) {
      if (
        segment.segmentIndex !== index ||
        !Array.isArray(segment.partIndexes) ||
        segment.partIndexes.length === 0 ||
        segment.partIndexes.length > 10_000 ||
        segment.partIndexes.some((part, partIndex) => part !== partIndex)
      ) {
        return json(400, { error: "invalid or duplicate segment parts" });
      }
      const seen = new Set<number>();
      for (const part of segment.partIndexes) {
        if (!Number.isSafeInteger(part) || part < 0 || seen.has(part)) {
          return json(400, { error: "invalid or duplicate segment parts" });
        }
        seen.add(part);
      }
    }
    sealing.add(job);
    return yield* finalizeJob({ ...finalizeData, job }).pipe(
      Effect.as(json(200, { finalized: true })),
      Effect.tapError((error) =>
        typeof error === "object" &&
        error !== null &&
        "_tag" in error &&
        (error._tag === "FfmpegFailed" || error._tag === "NoMediaStream")
          ? store.setFailed(job)
          : Effect.void
      ),
      Effect.ensuring(Effect.sync(() => sealing.delete(job)))
    );
  }
  if (request.method === "GET" && match[4] === "output") {
    if (sealing.has(job)) {
      return json(409, { error: "finalization in progress" });
    }
    const output = yield* store.getOutput(job);
    if (Option.isNone(output)) {
      return (yield* store.getStatus(job)) === "failed"
        ? json(409, { error: "output unavailable" })
        : json(404, { error: "output unavailable" });
    }
    yield* Effect.tryPromise(() => fs.access(output.value.path));
    return yield* HttpServerResponse.file(output.value.path, {
      contentLength: output.value.size,
      contentType: output.value.mediaType,
    }).pipe(
      Effect.map(
        HttpServerResponse.setHeader("x-content-sha256", output.value.checksum)
      )
    );
  }
  return json(405, { error: "method not allowed" });
});

export const finalizerHttpApp = route.pipe(
  Effect.catchAll((error) =>
    Effect.succeed(json(errorStatus(error), { error: message(error) }))
  )
);
