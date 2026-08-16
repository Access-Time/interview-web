import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, promises as fs } from "node:fs";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import { Effect, Layer, Option } from "effect";
import { JobNotOpen, PartAlreadyDiffers } from "../domain/errors.ts";

export interface StoredOutput {
  readonly checksum: string;
  readonly mediaType: "video/webm" | "video/mp4";
  readonly path: string;
  readonly size: number;
}
interface PartInput {
  bytes: Uint8Array;
  checksum: string;
  job: string;
  segment: number;
  sequence: number;
}
interface Store {
  assembleSegment: (input: {
    job: string;
    segment: number;
    partIndexes: readonly number[];
  }) => Effect.Effect<{ path: string }, Error | JobNotOpen>;
  deleteJob: (job: string) => Effect.Effect<void>;
  getOutput: (job: string) => Effect.Effect<Option.Option<StoredOutput>, Error>;
  getStatus: (job: string) => Effect.Effect<string, Error>;
  listParts: (job: string) => Effect.Effect<readonly string[], Error>;
  putPart: (input: PartInput) => Effect.Effect<void, Error>;
  setFailed: (job: string) => Effect.Effect<void, Error>;
  setOutput: (input: {
    job: string;
    output: StoredOutput;
  }) => Effect.Effect<void, Error | JobNotOpen>;
}

const makeStore = (root: string): Store => {
  const dir = (job: string) => path.join(root, job);
  const state = (job: string) => path.join(dir(job), "state.json");
  const readState = (job: string) =>
    fs.readFile(state(job), "utf8").then(JSON.parse) as Promise<{
      status: string;
      output?: StoredOutput;
    }>;
  const ensureState = async (job: string) => {
    await fs.mkdir(dir(job), { recursive: true });
    try {
      return await readState(job);
    } catch {
      await fs.writeFile(state(job), JSON.stringify({ status: "open" }), {
        flag: "wx",
      });
      return { status: "open" };
    }
  };
  const putPart = (input: PartInput) =>
    Effect.tryPromise({
      catch: (error) =>
        error instanceof PartAlreadyDiffers || error instanceof JobNotOpen
          ? error
          : new Error(String(error)),
      try: async () => {
        const current = await ensureState(input.job);
        if (current.status !== "open") {
          throw new JobNotOpen({ message: "job is not open" });
        }
        const file = path.join(
          dir(input.job),
          `part-${input.segment}-${input.sequence}.bin`
        );
        try {
          const existing = await fs.readFile(file);
          if (
            existing.byteLength !== input.bytes.byteLength ||
            createHash("sha256").update(existing).digest("hex") !==
              input.checksum
          ) {
            throw new PartAlreadyDiffers({ message: "part already differs" });
          }
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
            throw error;
          }
          await fs.writeFile(file, input.bytes, { flag: "wx" });
        }
      },
    });
  return {
    assembleSegment: (input) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof JobNotOpen ? error : new Error(String(error)),
        try: async () => {
          const current = await ensureState(input.job);
          if (current.status !== "open") {
            throw new JobNotOpen({ message: "job is not open" });
          }
          const files = input.partIndexes.map((n) =>
            path.join(dir(input.job), `part-${input.segment}-${n}.bin`)
          );
          if (files.length === 1) {
            return { path: files[0] as string };
          }
          const output = path.join(
            dir(input.job),
            `assembled-${input.segment}.bin`
          );
          await fs.writeFile(output, Buffer.alloc(0));
          for (const file of files) {
            // biome-ignore lint/performance/noAwaitInLoops: parts must be appended in manifest order.
            await pipeline(
              createReadStream(file),
              createWriteStream(output, { flags: "a" })
            );
          }
          return { path: output };
        },
      }),
    deleteJob: (job) =>
      Effect.promise(() => fs.rm(dir(job), { force: true, recursive: true })),
    getOutput: (job) =>
      Effect.tryPromise(async () => {
        try {
          const value = JSON.parse(await fs.readFile(state(job), "utf8"));
          return value.output ? Option.some(value.output) : Option.none();
        } catch {
          return Option.none();
        }
      }),
    getStatus: (job) =>
      Effect.tryPromise(async () => (await ensureState(job)).status),
    listParts: (job) =>
      Effect.tryPromise(async () => {
        const current = await ensureState(job);
        if (current.status !== "open") {
          throw new JobNotOpen({ message: "job is not open" });
        }
        return (await fs.readdir(dir(job))).filter(
          (file) => file.startsWith("part-") && file.endsWith(".bin")
        );
      }),
    putPart,
    setFailed: (job) =>
      Effect.tryPromise(async () => {
        const current = await ensureState(job);
        await fs.writeFile(
          state(job),
          JSON.stringify({ output: current.output ?? null, status: "failed" })
        );
      }),
    setOutput: (input) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof JobNotOpen ? error : new Error(String(error)),
        try: async () => {
          const current = await ensureState(input.job);
          if (current.status !== "open") {
            throw new JobNotOpen({ message: "job is not open" });
          }
          await fs.writeFile(
            state(input.job),
            JSON.stringify({ output: input.output, status: "done" })
          );
        },
      }),
  };
};

export class JobStore extends Effect.Service<JobStore>()("JobStore", {
  accessors: true,
  effect: Effect.succeed(
    makeStore(path.join(os.tmpdir(), "recording-finalizer"))
  ),
}) {}

export const makeJobStoreTest = (root: string): Layer.Layer<JobStore> =>
  Layer.succeed(JobStore, makeStore(root) as unknown as JobStore);
