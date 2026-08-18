import { Effect, Layer } from "effect";
import type { Sha256Hex } from "../domain/brands.ts";
import { ContainerRejected, InvalidContainerOutput } from "../domain/errors.ts";
import { normalizeSha256Checksum } from "../domain/media.ts";
import { makeWebmSeekable } from "../domain/webm-seekable.ts";
import { ContainerClient, type ContainerOutput } from "./container.ts";

interface JobState {
  output?: ContainerOutput & { bytes: Uint8Array };
  parts: Map<string, Uint8Array>;
}

const partKey = (segment: number, sequence: number) => `${segment}:${sequence}`;

const concat = (parts: readonly Uint8Array[]) => {
  const size = parts.reduce((total, part) => total + part.byteLength, 0);
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const part of parts) {
    bytes.set(part, offset);
    offset += part.byteLength;
  }
  return bytes;
};

const digest = async (bytes: Uint8Array) => {
  const hash = await crypto.subtle.digest("SHA-256", bytes);
  return normalizeSha256Checksum(hash) as Sha256Hex;
};

const streamOf = (bytes: Uint8Array) =>
  new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

const rejected = (message: string) =>
  new ContainerRejected({ message, status: 422 });

/**
 * Free-plan stand-in for the ffmpeg container. WebM parts are assembled and
 * each recovered encoder session stays its own seekable file. MP4 needs
 * ffmpeg, so those plans are rejected instead of publishing concatenated
 * bytes as ready.
 */
export const makePassthroughContainerClient =
  (): Layer.Layer<ContainerClient> => {
    const jobs = new Map<string, JobState>();
    const jobOf = (id: string) => {
      const existing = jobs.get(id);
      if (existing) {
        return existing;
      }
      const created: JobState = { parts: new Map() };
      jobs.set(id, created);
      return created;
    };
    return Layer.succeed(ContainerClient, {
      deleteJob: (job) =>
        Effect.sync(() => {
          jobs.delete(job);
        }),
      finalize: (input) =>
        Effect.gen(function* () {
          const job = jobOf(input.job);
          const assembled: Uint8Array[] = [];
          for (const segment of input.segments) {
            for (const sequence of segment.partIndexes) {
              const part = job.parts.get(
                partKey(segment.segmentIndex, sequence)
              );
              if (!part) {
                return yield* Effect.fail(
                  rejected("uploaded parts do not exactly match finalize plan")
                );
              }
              assembled.push(part);
            }
          }
          if (assembled.length !== job.parts.size) {
            return yield* Effect.fail(
              rejected("uploaded parts do not exactly match finalize plan")
            );
          }
          if (input.outputMediaType !== "video/webm") {
            return yield* Effect.fail(
              rejected("passthrough finalizer only supports video/webm")
            );
          }
          const bytes = makeWebmSeekable(concat(assembled));
          const checksum = yield* Effect.tryPromise({
            catch: () => rejected("output checksum unavailable"),
            try: () => digest(bytes),
          });
          job.output = {
            body: streamOf(bytes),
            bytes,
            checksum,
            mediaType: input.outputMediaType,
            size: bytes.byteLength,
          };
        }),
      getOutput: (job) =>
        Effect.gen(function* () {
          const output = jobs.get(job)?.output;
          if (!output) {
            return yield* Effect.fail(
              new InvalidContainerOutput({ message: "invalid output" })
            );
          }
          return {
            body: streamOf(output.bytes),
            checksum: output.checksum,
            mediaType: output.mediaType,
            size: output.size,
          };
        }),
      putPart: (input) =>
        Effect.sync(() => {
          jobOf(input.job).parts.set(
            partKey(input.segment, input.sequence),
            input.body
          );
          jobOf(input.job).output = undefined;
        }),
    });
  };
