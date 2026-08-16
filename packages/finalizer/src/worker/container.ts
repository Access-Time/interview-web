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
  bytes: Uint8Array;
  checksum: Sha256Hex;
  mediaType: "video/webm" | "video/mp4";
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
    }) => Effect.Effect<void, ContainerRejected | ContainerUnavailable>;
    readonly finalize: (input: {
      job: string;
      outputMediaType: "video/webm" | "video/mp4";
      segments: ReadonlyArray<{ partIndexes: number[]; segmentIndex: number }>;
    }) => Effect.Effect<void, ContainerRejected | ContainerUnavailable>;
    readonly getOutput: (
      job: string
    ) => Effect.Effect<
      ContainerOutput,
      InvalidContainerOutput | ContainerUnavailable
    >;
    readonly deleteJob: (job: string) => Effect.Effect<void>;
  }
>() {}

const hex = (bytes: ArrayBuffer) => normalizeSha256Checksum(bytes) as string;
const statusError = (status: number, what: string) =>
  [400, 413, 415, 422].includes(status)
    ? new ContainerRejected({ message: `${what}: ${status}`, status })
    : new ContainerUnavailable({ message: `${what}: ${status}`, status });
type ContainerNamespace = Parameters<typeof getContainer>[0];
export const makeContainerClient = (
  namespace: ContainerNamespace
): Layer.Layer<ContainerClient> =>
  Layer.succeed(ContainerClient, {
    deleteJob: (job) =>
      Effect.tryPromise(() =>
        getContainer(namespace).fetch(
          new URL(`/jobs/${job}`, "http://container"),
          { method: "DELETE" }
        )
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
        },
        "finalize"
      ),
    getOutput: (job) =>
      Effect.tryPromise({
        catch: (error) =>
          error instanceof InvalidContainerOutput ||
          error instanceof ContainerUnavailable
            ? error
            : new ContainerUnavailable({ message: "output unavailable" }),
        try: async () => {
          const response = await getContainer(namespace).fetch(
            new URL(`/jobs/${job}/output`, "http://container")
          );
          if (!response.ok) {
            throw statusError(response.status, "output");
          }
          const bytes = new Uint8Array(await response.arrayBuffer());
          const mediaType = response.headers.get("content-type");
          const checksum = response.headers
            .get("x-content-sha256")
            ?.toLowerCase();
          if (
            (mediaType !== "video/webm" && mediaType !== "video/mp4") ||
            bytes.byteLength !==
              Number(response.headers.get("content-length")) ||
            !checksum ||
            checksum !== hex(await crypto.subtle.digest("SHA-256", bytes))
          ) {
            throw new InvalidContainerOutput({ message: "invalid output" });
          }
          return { bytes, checksum: checksum as Sha256Hex, mediaType };
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
        },
        "part upload"
      ),
  });
const request = (
  namespace: ContainerNamespace,
  path: string,
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
        new URL(path, "http://container"),
        init
      );
      if (!response.ok) {
        throw statusError(response.status, what);
      }
    },
  });
