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
  FinalizerDbUnavailable,
  MissingOrCorruptPart,
  RecordingsUnavailable,
} from "../src/domain/errors.ts";
import { ContainerClient } from "../src/worker/container.ts";
import { makeFinalizerDbTest } from "../src/worker/db.ts";
import { makePassthroughContainerClient } from "../src/worker/passthrough.ts";
import { processFinalization } from "../src/worker/process.ts";
import { makeRecordingsTest, Recordings } from "../src/worker/recordings.ts";

const unusedContainer = Layer.succeed(ContainerClient, {
  deleteJob: () => Effect.void,
  finalize: () => Effect.void,
  getOutput: () => Effect.die("unused"),
  putPart: () => Effect.void,
});

const validJob = {
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
};

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

it.effect(
  "invalid manifest after claim fails the job and does not release",
  () => {
    const calls: string[] = [];
    const layer = Layer.mergeAll(
      makeFinalizerDbTest({
        claim: () =>
          Effect.succeed(
            Option.some({
              ...validJob,
              manifest: { segments: [], sessionId: "session" },
            } as never)
          ),
        fail: (input) =>
          Effect.sync(() => {
            calls.push(`fail:${input.failureCode}`);
            return true;
          }),
        release: () =>
          Effect.sync(() => {
            calls.push("release");
            return true;
          }),
      }),
      makeRecordingsTest(new Map()),
      unusedContainer
    );
    return processFinalization("session" as never).pipe(
      Effect.provide(layer),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls).toEqual(["fail:InvalidManifest"]);
        })
      )
    );
  }
);

it.effect(
  "invalid finalize plan after claim fails the job and does not release",
  () => {
    const calls: string[] = [];
    const layer = Layer.mergeAll(
      makeFinalizerDbTest({
        claim: () =>
          Effect.succeed(
            Option.some({ ...validJob, finalizePlan: "[]" } as never)
          ),
        fail: (input) =>
          Effect.sync(() => {
            calls.push(`fail:${input.failureCode}`);
            return true;
          }),
        release: () =>
          Effect.sync(() => {
            calls.push("release");
            return true;
          }),
      }),
      makeRecordingsTest(new Map()),
      unusedContainer
    );
    return processFinalization("session" as never).pipe(
      Effect.provide(layer),
      Effect.asVoid,
      Effect.tap(() =>
        Effect.sync(() => {
          expect(calls).toEqual(["fail:InvalidFinalizePlan"]);
        })
      )
    );
  }
);

it.effect(
  "RecordingsUnavailable after claim releases and does not fail",
  () => {
    const calls: string[] = [];
    const layer = Layer.mergeAll(
      makeFinalizerDbTest({
        claim: () => Effect.succeed(Option.some(validJob as never)),
        fail: () =>
          Effect.sync(() => {
            calls.push("fail");
            return true;
          }),
        ready: () => Effect.succeed(Option.none()),
        release: () =>
          Effect.sync(() => {
            calls.push("release");
            return true;
          }),
        renew: () => Effect.succeed(true),
      }),
      Layer.succeed(Recordings, {
        delete: () => Effect.void,
        get: () =>
          Effect.fail(new RecordingsUnavailable({ message: "r2 unavailable" })),
        head: () => Effect.succeed(Option.none()),
        put: () => Effect.succeed(Option.none()),
      }),
      unusedContainer
    );
    return processFinalization("session" as never).pipe(
      Effect.provide(layer),
      Effect.either,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("RecordingsUnavailable");
          }
          expect(calls).toEqual(["release"]);
        })
      )
    );
  }
);

it.effect("FinalizerDbUnavailable from claim does not fail or release", () => {
  const calls: string[] = [];
  const layer = Layer.mergeAll(
    makeFinalizerDbTest({
      claim: () =>
        Effect.fail(new FinalizerDbUnavailable({ message: "d1 unavailable" })),
      fail: () =>
        Effect.sync(() => {
          calls.push("fail");
          return true;
        }),
      release: () =>
        Effect.sync(() => {
          calls.push("release");
          return true;
        }),
    }),
    makeRecordingsTest(new Map()),
    unusedContainer
  );
  return processFinalization("session" as never).pipe(
    Effect.provide(layer),
    Effect.either,
    Effect.tap((result) =>
      Effect.sync(() => {
        expect(result._tag).toBe("Left");
        if (result._tag === "Left") {
          expect(result.left._tag).toBe("FinalizerDbUnavailable");
        }
        expect(calls).toEqual([]);
      })
    )
  );
});

it.effect("missing part fails before container finalize", () => {
  let finalized = false;
  let failed: string | undefined;
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
      fail: (input) =>
        Effect.sync(() => {
          failed = input.failureCode;
          return true;
        }),
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
    Effect.tap(() =>
      Effect.sync(() => {
        expect(finalized).toBe(false);
        expect(failed).toBe("MissingOrCorruptPart");
      })
    )
  );
});

it.effect("passthrough concat publishes the assembled parts", () => {
  const part = new Uint8Array([1]);
  let published: { checksum?: string; size?: number } = {};
  let completed = false;
  const layer = Layer.mergeAll(
    makeFinalizerDbTest({
      claim: () => Effect.succeed(Option.some(validJob as never)),
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
          body: part,
          checksum: "a".repeat(64) as never,
          size: part.byteLength,
        }),
      head: () => Effect.succeed(Option.none()),
      put: (_key, _body, options) =>
        Effect.sync(() => {
          published = { checksum: options.sha256, size: options.size };
          return Option.some({
            checksums: { sha256: options.sha256 },
            httpMetadata: options.httpMetadata,
            size: options.size,
          });
        }),
    }),
    makePassthroughContainerClient()
  );
  return processFinalization("session" as never).pipe(
    Effect.provide(layer),
    Effect.asVoid,
    Effect.flatMap(() =>
      Effect.promise(async () => {
        const hash = await crypto.subtle.digest("SHA-256", part);
        return Array.from(new Uint8Array(hash), (byte) =>
          byte.toString(16).padStart(2, "0")
        ).join("");
      })
    ),
    Effect.tap((checksum) =>
      Effect.sync(() => {
        expect(completed).toBe(true);
        expect(published.size).toBe(1);
        expect(published.checksum).toBe(checksum);
      })
    )
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

it.effect(
  "unpublished output delete transport releases and does not fail",
  () => {
    const calls: string[] = [];
    const checksum = "a".repeat(64);
    const layer = Layer.mergeAll(
      makeFinalizerDbTest({
        claim: () => Effect.succeed(Option.some(validJob as never)),
        complete: () => Effect.succeed(false),
        fail: () =>
          Effect.sync(() => {
            calls.push("fail");
            return true;
          }),
        ready: () => Effect.succeed(Option.none()),
        release: () =>
          Effect.sync(() => {
            calls.push("release");
            return true;
          }),
        renew: () => Effect.succeed(true),
      }),
      Layer.succeed(Recordings, {
        delete: () =>
          Effect.fail(new RecordingsUnavailable({ message: "r2 delete" })),
        get: () =>
          Effect.succeed({
            body: new Uint8Array([1]),
            checksum: checksum as never,
            size: 1,
          }),
        head: () => Effect.succeed(Option.none()),
        put: () =>
          Effect.succeed(
            Option.some({
              checksums: { sha256: checksum },
              httpMetadata: { contentType: "video/webm" },
              size: 3,
            })
          ),
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
      Effect.either,
      Effect.tap((result) =>
        Effect.sync(() => {
          expect(result._tag).toBe("Left");
          if (result._tag === "Left") {
            expect(result.left._tag).toBe("RecordingsUnavailable");
          }
          expect(calls).toEqual(["release"]);
        })
      )
    );
  }
);
