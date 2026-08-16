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
import { ContainerClient } from "../src/worker/container.ts";
import { makeFinalizerDbTest } from "../src/worker/db.ts";
import { processFinalization } from "../src/worker/process.ts";
import { makeRecordingsTest } from "../src/worker/recordings.ts";

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
