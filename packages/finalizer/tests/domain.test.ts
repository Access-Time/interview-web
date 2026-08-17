import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SessionId } from "../src/domain/brands.ts";
import {
  FinalizerDbUnavailable,
  InvalidManifest,
  isTerminalFinalization,
  LeaseLost,
  RecordingsUnavailable,
} from "../src/domain/errors.ts";
import {
  isExactPublishedObject,
  normalizeSha256Checksum,
} from "../src/domain/media.ts";
import { decodeFinalizePlan, decodeManifest } from "../src/domain/validate.ts";

const part = {
  byteSize: 1,
  checksum: "a".repeat(64),
  objectKey: "p",
  sequence: 0,
};
const manifest = {
  segments: [{ id: "seg", index: 0, parts: [part] }],
  sessionId: "s",
};

it.effect("SessionId rejects empty and overlong values", () =>
  Effect.gen(function* () {
    const empty = yield* Schema.decodeUnknown(SessionId)("").pipe(
      Effect.either
    );
    const long = yield* Schema.decodeUnknown(SessionId)("x".repeat(129)).pipe(
      Effect.either
    );
    const ok = yield* Schema.decodeUnknown(SessionId)("s1");
    expect(empty._tag).toBe("Left");
    expect(long._tag).toBe("Left");
    expect(ok).toBe("s1");
  })
);

it("checksum normalization accepts hex strings and bytes", () => {
  const checksum = "a".repeat(64);
  expect(normalizeSha256Checksum(checksum.toUpperCase())).toBe(checksum);
  const bytes = Uint8Array.from(checksum.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );
  expect(normalizeSha256Checksum(bytes)).toBe(checksum);
  expect(
    isExactPublishedObject(
      {
        checksums: { sha256: checksum },
        httpMetadata: { contentType: "video/webm" },
        size: 4,
      },
      { checksum, mediaType: "video/webm", size: 4 }
    )
  ).toBe(true);
});

it("terminal predicate distinguishes tagged errors", () => {
  expect(
    isTerminalFinalization(new InvalidManifest({ message: "invalid manifest" }))
  ).toBe(true);
  expect(
    isTerminalFinalization(
      new LeaseLost({ message: "finalization lease lost" })
    )
  ).toBe(false);
  expect(
    isTerminalFinalization(
      new RecordingsUnavailable({ message: "r2 unavailable" })
    )
  ).toBe(false);
  expect(
    isTerminalFinalization(
      new FinalizerDbUnavailable({ message: "d1 unavailable" })
    )
  ).toBe(false);
});

it.effect("decodeManifest accepts a contiguous part and rejects a gap", () =>
  Effect.gen(function* () {
    const ok = yield* decodeManifest(manifest);
    expect(ok.segments[0]?.parts.length).toBe(1);
    const gap = yield* decodeManifest({
      ...manifest,
      segments: [{ id: "seg", index: 0, parts: [{ ...part, sequence: 1 }] }],
    }).pipe(Effect.either);
    expect(gap._tag).toBe("Left");
    if (gap._tag === "Left") {
      expect(gap.left._tag).toBe("InvalidPart");
    }
  })
);

it.effect("decodeFinalizePlan requires matching segmentId and partCount", () =>
  Effect.gen(function* () {
    const decoded = yield* decodeManifest(manifest);
    const plan = yield* decodeFinalizePlan(
      decoded,
      JSON.stringify([{ partCount: 1, segmentId: "seg" }])
    );
    expect(plan).toEqual([{ partCount: 1, segmentId: "seg" }]);
    const bad = yield* decodeFinalizePlan(decoded, "[]").pipe(Effect.either);
    expect(bad._tag).toBe("Left");
  })
);
