import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import {
  makeRecordings,
  makeRecordingsTest,
  Recordings,
} from "../src/worker/recordings.ts";

it.effect(
  "Recordings.get fails MissingOrCorruptPart on checksum mismatch",
  () =>
    Effect.gen(function* () {
      const result = yield* Recordings.get("k").pipe(
        Effect.provide(
          makeRecordingsTest({
            k: {
              body: new Uint8Array([1]),
              checksum: "b".repeat(64) as never,
              size: 1,
            },
          })
        ),
        Effect.flip
      );
      expect(result._tag).toBe("MissingOrCorruptPart");
    })
);
it.effect("Recordings.head returns none for a missing key", () =>
  Effect.gen(function* () {
    const result = yield* Recordings.head("missing").pipe(
      Effect.provide(makeRecordingsTest(new Map()))
    );
    expect(Option.isNone(result)).toBe(true);
  })
);

it.effect(
  "makeRecordings maps bucket.get rejection to RecordingsUnavailable",
  () =>
    Effect.gen(function* () {
      const result = yield* Recordings.get("k").pipe(
        Effect.provide(
          makeRecordings({
            get: () => Promise.reject(new Error("r2 down")),
          } as never)
        ),
        Effect.flip
      );
      expect(result._tag).toBe("RecordingsUnavailable");
    })
);

it.effect(
  "makeRecordings maps bucket.head rejection to RecordingsUnavailable",
  () =>
    Effect.gen(function* () {
      const result = yield* Recordings.head("k").pipe(
        Effect.provide(
          makeRecordings({
            head: () => Promise.reject(new Error("r2 down")),
          } as never)
        ),
        Effect.flip
      );
      expect(result._tag).toBe("RecordingsUnavailable");
    })
);

it.effect(
  "makeRecordings maps bucket.put rejection to RecordingsUnavailable",
  () =>
    Effect.gen(function* () {
      const recordings = yield* Recordings.pipe(
        Effect.provide(
          makeRecordings({
            put: () => Promise.reject(new Error("r2 down")),
          } as never)
        )
      );
      const result = yield* recordings
        .put("k", new Uint8Array([1]), {
          httpMetadata: { contentType: "video/webm" },
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: "a".repeat(64),
        })
        .pipe(Effect.flip);
      expect(result._tag).toBe("RecordingsUnavailable");
    })
);

it.effect(
  "makeRecordings.put gives R2 a known-length body for fetch streams",
  () =>
    Effect.gen(function* () {
      let received: unknown;
      const recordings = yield* Recordings.pipe(
        Effect.provide(
          makeRecordings({
            put: (_key: string, body: unknown) => {
              if (body instanceof ReadableStream) {
                return Promise.reject(
                  new TypeError(
                    "Provided readable stream must have a known length (request/response body or readable half of FixedLengthStream)"
                  )
                );
              }
              received = body;
              return Promise.resolve({
                size: (body as Uint8Array).byteLength,
              });
            },
          } as never)
        )
      );
      const result = yield* recordings.put(
        "k",
        new ReadableStream({
          start(controller) {
            controller.enqueue(new Uint8Array([1, 2, 3]));
            controller.close();
          },
        }),
        {
          httpMetadata: { contentType: "video/webm" },
          onlyIf: { etagDoesNotMatch: "*" },
          sha256: "a".repeat(64),
        }
      );
      expect(Option.isSome(result)).toBe(true);
      expect(received).toEqual(new Uint8Array([1, 2, 3]));
    })
);

it.effect(
  "makeRecordings maps bucket.delete rejection to RecordingsUnavailable",
  () =>
    Effect.gen(function* () {
      const recordings = yield* Recordings.pipe(
        Effect.provide(
          makeRecordings({
            delete: () => Promise.reject(new Error("r2 down")),
          } as never)
        )
      );
      const result = yield* recordings.delete("k").pipe(Effect.flip);
      expect(result._tag).toBe("RecordingsUnavailable");
    })
);
