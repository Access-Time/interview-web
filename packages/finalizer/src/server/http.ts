import { createHash } from "node:crypto";
import { promises as fs } from "node:fs";
import { HttpServerRequest, HttpServerResponse } from "@effect/platform";
import { Effect, Option } from "effect";
import { Ffmpeg } from "./ffmpeg.ts";
import { finalizeJob } from "./finalize.ts";
import { JobStore } from "./job-store.ts";

const jobPattern =
  /^\/jobs\/([A-Za-z0-9_-]{1,128})(?:\/parts\/(0|[1-9][0-9]*)\/(0|[1-9][0-9]*)|\/(finalize|output))?$/;
const checksumPattern = /^[a-f\d]{64}$/i;
const mediaTypes = new Set(["video/webm", "video/mp4"]);
const sealing = new Set<string>();

const json = (status: number, value: unknown) =>
  HttpServerResponse.unsafeJson(value, { status });
const errorStatus = (error: unknown) => {
  if (typeof error === "object" && error !== null && "_tag" in error) {
    switch (error._tag) {
      case "PartsPlanMismatch":
      case "JobNotOpen":
      case "PartAlreadyDiffers":
        return 409;
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

const body = (request: HttpServerRequest.HttpServerRequest) =>
  Effect.map(request.arrayBuffer, (value) => new Uint8Array(value));

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
    const bytes = yield* body(request);
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
    const data = yield* request.json;
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
    sealing.add(job);
    return yield* finalizeJob({ ...finalizeData, job }).pipe(
      Effect.as(json(200, { finalized: true })),
      Effect.ensuring(Effect.sync(() => sealing.delete(job)))
    );
  }
  if (request.method === "GET" && match[4] === "output") {
    if (sealing.has(job)) {
      return json(409, { error: "finalization in progress" });
    }
    const output = yield* store.getOutput(job);
    if (Option.isNone(output)) {
      return json(404, { error: "output unavailable" });
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
