import { expect, it } from "@effect/vitest";
import { Effect, Option } from "effect";
import { makeRecordingsTest, Recordings } from "../src/worker/recordings.ts";

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
