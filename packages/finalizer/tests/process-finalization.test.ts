import { expect, it } from "@effect/vitest";
import { vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));
vi.mock("cloudflare:workers", () => ({ env: {} }));
vi.mock("@interview-web/db", () => ({
  claimRecordingFinalization: vi.fn(),
  completeRecordingFinalization: vi.fn(),
  failRecordingFinalization: vi.fn(),
  getReadyRecordingSubmission: vi.fn(),
  listRecordingsForFinalization: vi.fn(),
  releaseRecordingFinalizationForRetry: vi.fn(),
  renewRecordingFinalizationLease: vi.fn(),
}));

import { Effect, Layer, Option } from "effect";
import {
  MissingOrCorruptPart,
  RecordingsUnavailable,
} from "../src/domain/errors.ts";
import { ContainerClient } from "../src/worker/container.ts";
import { makeFinalizerDbTest } from "../src/worker/db.ts";
import { processFinalization } from "../src/worker/process.ts";
import { makeRecordingsTest, Recordings } from "../src/worker/recordings.ts";

it.effect("recordings get transport stays RecordingsUnavailable", () => {
  const layer = Layer.mergeAll(
    makeFinalizerDbTest({
      claim: () =>
        Effect.succeed(
          Option.some({
            attempt: 1,
            finalizePlan: JSON.stringify([{ partCount: 1, segmentId: "seg" }]),
            manifest: {
              segments: [
                {
                  id: "seg",
                  index: 0,
                  parts: [
                    {
                      byteSize: 1,
                      checksum: "a".repeat(64),
                      objectKey: "part",
                      sequence: 0,
                    },
                  ],
                },
              ],
              sessionId: "session",
            },
          } as never)
        ),
      fail: () => Effect.sync(() => true),
      ready: () => Effect.succeed(Option.none()),
      release: () => Effect.sync(() => true),
      renew: () => Effect.succeed(true),
    }),
    Layer.succeed(Recordings, {
      delete: () => Effect.void,
      get: () =>
        Effect.fail(new RecordingsUnavailable({ message: "r2 unavailable" })),
      head: () => Effect.succeed(Option.none()),
      put: () => Effect.succeed(Option.none()),
    }),
    Layer.succeed(ContainerClient, {
      deleteJob: () => Effect.void,
      finalize: () => Effect.void,
      getOutput: () => Effect.die("unused"),
      putPart: () => Effect.void,
    })
  );
  return processFinalization("session" as never).pipe(
    Effect.provide(layer),
    Effect.either,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("RecordingsUnavailable");
          expect(result.left).not.toBeInstanceOf(MissingOrCorruptPart);
        }
      })
    )
  );
});

it.effect("claim none does not complete", () => {
  let completed = false;
  const layer = Layer.mergeAll(
    makeFinalizerDbTest({
      claim: () => Effect.succeed(Option.none()),
      complete: () =>
        Effect.sync(() => {
          completed = true;
          return true;
        }),
    }),
    makeRecordingsTest(new Map()),
    Layer.succeed(ContainerClient, {
      deleteJob: () => Effect.void,
      finalize: () => Effect.void,
      getOutput: () => Effect.die("unused"),
      putPart: () => Effect.void,
    })
  );
  return processFinalization("session" as never).pipe(
    Effect.provide(layer),
    Effect.asVoid,
    Effect.tap(() => Effect.sync(() => expect(completed).toBe(false)))
  );
});

it.effect("missing part fails before container finalize", () => {
  let finalized = false;
  const layer = Layer.mergeAll(
    makeFinalizerDbTest({
      claim: () =>
        Effect.succeed(
          Option.some({
            attempt: 1,
            finalizePlan: JSON.stringify([{ partCount: 1, segmentId: "seg" }]),
            manifest: {
              segments: [
                {
                  id: "seg",
                  index: 0,
                  parts: [
                    {
                      byteSize: 1,
                      checksum: "a".repeat(64),
                      objectKey: "missing",
                      sequence: 0,
                    },
                  ],
                },
              ],
              sessionId: "session",
            },
          } as never)
        ),
      fail: () => Effect.sync(() => true),
      ready: () => Effect.succeed(Option.none()),
      renew: () => Effect.succeed(true),
    }),
    makeRecordingsTest(new Map()),
    Layer.succeed(ContainerClient, {
      deleteJob: () => Effect.void,
      finalize: () =>
        Effect.sync(() => {
          finalized = true;
        }),
      getOutput: () => Effect.die("unused"),
      putPart: () => Effect.void,
    })
  );
  return processFinalization("session" as never).pipe(
    Effect.provide(layer),
    Effect.asVoid,
    Effect.tap(() => Effect.sync(() => expect(finalized).toBe(false)))
  );
});

it.effect("streams container output to R2 with the container checksum", () => {
  const checksum = "a".repeat(64);
  let putBody: unknown;
  let completed = false;
  const layer = Layer.mergeAll(
    makeFinalizerDbTest({
      claim: () =>
        Effect.succeed(
          Option.some({
            attempt: 1,
            finalizePlan: JSON.stringify([{ partCount: 1, segmentId: "seg" }]),
            manifest: {
              segments: [
                {
                  id: "seg",
                  index: 0,
                  parts: [
                    {
                      byteSize: 1,
                      checksum,
                      objectKey: "part",
                      sequence: 0,
                    },
                  ],
                },
              ],
              sessionId: "session",
            },
          } as never)
        ),
      complete: () =>
        Effect.sync(() => {
          completed = true;
          return true;
        }),
      ready: () => Effect.succeed(Option.none()),
      renew: () => Effect.succeed(true),
    }),
    Layer.succeed(Recordings, {
      delete: () => Effect.void,
      get: () =>
        Effect.succeed({
          body: new Uint8Array([1]),
          checksum: checksum as never,
          size: 1,
        }),
      head: () => Effect.succeed(Option.none()),
      put: (_key, body, options) =>
        Effect.sync(() => {
          putBody = body;
          return Option.some({
            checksums: { sha256: options.sha256 },
            httpMetadata: options.httpMetadata,
            size: 3,
          });
        }),
    }),
    Layer.succeed(ContainerClient, {
      deleteJob: () => Effect.void,
      finalize: () => Effect.void,
      getOutput: () =>
        Effect.succeed({
          body: new ReadableStream({
            start(controller) {
              controller.enqueue(new Uint8Array([1, 2, 3]));
              controller.close();
            },
          }),
          checksum: checksum as never,
          mediaType: "video/webm",
          size: 3,
        }),
      putPart: () => Effect.void,
    })
  );
  return processFinalization("session" as never).pipe(
    Effect.provide(layer),
    Effect.asVoid,
    Effect.tap(() =>
      Effect.sync(() => {
        expect(putBody).toBeInstanceOf(ReadableStream);
        expect(completed).toBe(true);
      })
    )
  );
});
