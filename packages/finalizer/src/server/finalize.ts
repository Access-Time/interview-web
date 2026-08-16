import { createHash, randomUUID } from "node:crypto";
import { promises as fs } from "node:fs";
import path from "node:path";
import { Effect } from "effect";
import { PartsPlanMismatch } from "../domain/errors.ts";
import { Ffmpeg } from "./ffmpeg.ts";
import { JobStore } from "./job-store.ts";

export const finalizeJob = Effect.fn("finalizeJob")(function* (input: {
  job: string;
  outputMediaType: "video/webm" | "video/mp4";
  segments: ReadonlyArray<{ partIndexes: number[]; segmentIndex: number }>;
}) {
  const store = yield* JobStore;
  const ffmpeg = yield* Ffmpeg;
  const parts = yield* store.listParts(input.job);
  const expected = input.segments.flatMap((segment) =>
    segment.partIndexes.map(
      (part) => `part-${segment.segmentIndex}-${part}.bin`
    )
  );
  if (
    parts.length !== expected.length ||
    parts.some((part) => !expected.includes(part))
  ) {
    return yield* Effect.fail(
      new PartsPlanMismatch({
        message: "uploaded parts do not exactly match finalize plan",
      })
    );
  }
  const run = `run-${randomUUID()}`;
  const remuxed: string[] = [];
  for (const segment of input.segments) {
    const assembled = yield* store.assembleSegment({
      job: input.job,
      partIndexes: segment.partIndexes,
      segment: segment.segmentIndex,
    });
    const output = path.join(
      path.dirname(assembled.path),
      `${run}-${segment.segmentIndex}.${input.outputMediaType === "video/mp4" ? "mp4" : "webm"}`
    );
    yield* ffmpeg.remux({
      cwd: path.dirname(assembled.path),
      inputPath: assembled.path,
      mediaType: input.outputMediaType,
      outputPath: output,
    });
    yield* ffmpeg.probe({ cwd: path.dirname(assembled.path), file: output });
    remuxed.push(output);
  }
  const first = remuxed[0] as string;
  const finalPath =
    remuxed.length === 1
      ? first
      : path.join(
          path.dirname(first),
          `${run}-final.${input.outputMediaType === "video/mp4" ? "mp4" : "webm"}`
        );
  if (remuxed.length > 1) {
    const listPath = path.join(path.dirname(finalPath), `${run}-concat.txt`);
    yield* Effect.promise(() =>
      fs.writeFile(
        listPath,
        `${remuxed.map((file) => `file '${path.basename(file)}'`).join("\n")}\n`
      )
    );
    yield* ffmpeg.concat({
      cwd: path.dirname(finalPath),
      listPath,
      mediaType: input.outputMediaType,
      outputPath: finalPath,
    });
  }
  yield* ffmpeg.probe({ cwd: path.dirname(finalPath), file: finalPath });
  const stat = (yield* Effect.tryPromise(() =>
    fs.stat(finalPath, { bigint: false })
  )) as { size: number };
  const checksum = yield* Effect.tryPromise(async () =>
    createHash("sha256")
      .update(await fs.readFile(finalPath))
      .digest("hex")
  );
  yield* store.setOutput({
    job: input.job,
    output: {
      checksum,
      mediaType: input.outputMediaType,
      path: finalPath,
      size: stat.size,
    },
  });
});
