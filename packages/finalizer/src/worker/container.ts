import { getContainer } from "@cloudflare/containers";
import { Context, Effect, Layer } from "effect";
import type { Sha256Hex } from "../domain/brands.ts";
import {
  ContainerRejected,
  ContainerUnavailable,
  InvalidContainerOutput,
} from "../domain/errors.ts";
import { normalizeSha256Checksum } from "../domain/media.ts";

export interface ContainerOutput {
  body: ReadableStream<Uint8Array>;
  checksum: Sha256Hex;
  mediaType: "video/webm" | "video/mp4";
  size: number;
}
export class ContainerClient extends Context.Tag("ContainerClient")<
  ContainerClient,
  {
    readonly putPart: (input: {
      job: string;
      segment: number;
      sequence: number;
      body: Uint8Array;
      checksum: string;
      signal?: AbortSignal;
    }) => Effect.Effect<void, ContainerRejected | ContainerUnavailable>;
    readonly finalize: (input: {
      job: string;
      outputMediaType: "video/webm" | "video/mp4";
      segments: ReadonlyArray<{ partIndexes: number[]; segmentIndex: number }>;
      signal?: AbortSignal;
    }) => Effect.Effect<void, ContainerRejected | ContainerUnavailable>;
    readonly getOutput: (
      job: string,
      signal?: AbortSignal
    ) => Effect.Effect<
      ContainerOutput,
      InvalidContainerOutput | ContainerUnavailable
    >;
    readonly deleteJob: (job: string) => Effect.Effect<void>;
  }
>() {}

const statusError = (status: number, what: string) =>
  [400, 413, 415, 422].includes(status)
    ? new ContainerRejected({ message: `${what}: ${status}`, status })
    : new ContainerUnavailable({ message: `${what}: ${status}`, status });
type ContainerNamespace = Parameters<typeof getContainer>[0];
const request = (
  namespace: ContainerNamespace,
  urlPath: string,
  init: RequestInit,
  what: string
) =>
  Effect.tryPromise({
    catch: (error) =>
      error instanceof ContainerRejected ||
      error instanceof ContainerUnavailable
        ? error
        : new ContainerUnavailable({ message: `${what} unavailable` }),
    try: async () => {
      const response = await getContainer(namespace).fetch(
        new URL(urlPath, "http://container"),
        init
      );
      if (!response.ok) {
        throw statusError(response.status, what);
      }
    },
  });

export const makeContainerClient = (
  namespace: ContainerNamespace
): Layer.Layer<ContainerClient> =>
  Layer.succeed(ContainerClient, {
    deleteJob: (job) =>
      request(
        namespace,
        `/jobs/${job}`,
        { method: "DELETE" },
        "delete job"
      ).pipe(Effect.asVoid, Effect.orDie),
    finalize: (input) =>
      request(
        namespace,
        `/jobs/${input.job}/finalize`,
        {
          body: JSON.stringify({
            outputMediaType: input.outputMediaType,
            segments: input.segments,
          }),
          headers: { "content-type": "application/json" },
          method: "POST",
          signal: input.signal,
        },
        "finalize"
      ),
    getOutput: (job, signal) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof InvalidContainerOutput ||
          error instanceof ContainerUnavailable
            ? error
            : new ContainerUnavailable({ message: "output unavailable" }),
        try: async () => {
          const response = await getContainer(namespace).fetch(
            new URL(`/jobs/${job}/output`, "http://container"),
            { signal }
          );
          if (!response.ok) {
            throw statusError(response.status, "output");
          }
          const mediaType = response.headers.get("content-type");
          const checksum = normalizeSha256Checksum(
            response.headers.get("x-content-sha256") ?? undefined
          );
          const size = Number(response.headers.get("content-length"));
          if (
            (mediaType !== "video/webm" && mediaType !== "video/mp4") ||
            !response.body ||
            !Number.isInteger(size) ||
            size < 0 ||
            !checksum
          ) {
            throw new InvalidContainerOutput({ message: "invalid output" });
          }
          return {
            body: response.body,
            checksum: checksum as Sha256Hex,
            mediaType,
            size,
          };
        },
      }),
    putPart: (input) =>
      request(
        namespace,
        `/jobs/${input.job}/parts/${input.segment}/${input.sequence}`,
        {
          body: input.body,
          headers: {
            "content-length": String(input.body.byteLength),
            "x-content-sha256": input.checksum,
          },
          method: "PUT",
          signal: input.signal,
        },
        "part upload"
      ),
  });
