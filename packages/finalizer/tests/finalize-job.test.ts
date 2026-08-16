import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { Effect, Layer, Option } from "effect";
import { describe, expect, it } from "vitest";
import { type FfmpegTest, makeFfmpegTest } from "../src/server/ffmpeg.ts";
import { finalizeJob } from "../src/server/finalize.ts";
import { JobStore, makeJobStoreTest } from "../src/server/job-store.ts";

const runCase = async (
  segments: ReadonlyArray<{ partIndexes: number[]; segmentIndex: number }>,
  ffmpeg: FfmpegTest
) => {
  const root = await mkdtemp(path.join(os.tmpdir(), "finalizer-test-"));
  try {
    const store = makeJobStoreTest(root);
    const layer = Layer.merge(store, makeFfmpegTest(ffmpeg));
    await Effect.runPromise(
      Effect.gen(function* () {
        yield* JobStore.putPart({
          bytes: new TextEncoder().encode("a"),
          checksum: "bad",
          job: "job",
          segment: 0,
          sequence: 0,
        });
        if (segments.length === 1 && segments[0]?.partIndexes.length === 2) {
          yield* JobStore.putPart({
            bytes: new TextEncoder().encode("b"),
            checksum: "bad",
            job: "job",
            segment: 0,
            sequence: 1,
          });
        }
        if (segments.length > 1) {
          yield* JobStore.putPart({
            bytes: new TextEncoder().encode("c"),
            checksum: "bad",
            job: "job",
            segment: 1,
            sequence: 0,
          });
        }
        yield* finalizeJob({
          job: "job",
          outputMediaType: "video/webm",
          segments,
        }).pipe(Effect.provide(layer));
      }).pipe(Effect.provide(layer))
    );
  } finally {
    await rm(root, { force: true, recursive: true });
  }
};

describe("finalizeJob", () => {
  it("assembles two parts and does not concat one segment", async () => {
    let concatCalls = 0;
    let remuxInput = "";
    const ffmpeg = {
      concat: ({ outputPath }: { outputPath: string }) =>
        Effect.promise(() =>
          writeFile(outputPath, "joined").then(() => {
            concatCalls += 1;
          })
        ),
      probe: () => Effect.void,
      remux: ({
        inputPath,
        outputPath,
      }: {
        inputPath: string;
        outputPath: string;
      }) =>
        Effect.promise(async () => {
          remuxInput = new TextDecoder().decode(await readFile(inputPath));
          await writeFile(outputPath, remuxInput);
        }),
    } as unknown as FfmpegTest;
    await runCase([{ partIndexes: [0, 1], segmentIndex: 0 }], ffmpeg);
    expect(remuxInput).toBe("ab");
    expect(concatCalls).toBe(0);
  });

  it("concats remuxed files for two segments", async () => {
    let concatCalls = 0;
    const ffmpeg = {
      concat: ({ outputPath }: { outputPath: string }) =>
        Effect.promise(() =>
          writeFile(outputPath, "joined").then(() => {
            concatCalls += 1;
          })
        ),
      probe: () => Effect.void,
      remux: ({ outputPath }: { outputPath: string }) =>
        Effect.promise(() => writeFile(outputPath, "segment")),
    } as unknown as FfmpegTest;
    await runCase(
      [
        { partIndexes: [0], segmentIndex: 0 },
        { partIndexes: [0], segmentIndex: 1 },
      ],
      ffmpeg
    );
    expect(concatCalls).toBe(1);
  });

  it("leaves output empty when remux fails", async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), "finalizer-test-"));
    try {
      const layer = Layer.merge(
        makeJobStoreTest(root),
        makeFfmpegTest({
          concat: () => Effect.void,
          probe: () => Effect.void,
          remux: () => Effect.fail(new Error("failed")),
        } as unknown as FfmpegTest)
      );
      await Effect.runPromise(
        Effect.gen(function* () {
          yield* JobStore.putPart({
            bytes: new Uint8Array([1]),
            checksum: "bad",
            job: "job",
            segment: 0,
            sequence: 0,
          });
          yield* finalizeJob({
            job: "job",
            outputMediaType: "video/webm",
            segments: [{ partIndexes: [0], segmentIndex: 0 }],
          }).pipe(Effect.provide(layer), Effect.flip);
          expect(Option.isNone(yield* JobStore.getOutput("job"))).toBe(true);
        }).pipe(Effect.provide(layer))
      );
    } finally {
      await rm(root, { force: true, recursive: true });
    }
  });
});
