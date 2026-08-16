import { expect, it } from "@effect/vitest";
import { Effect, Schema } from "effect";
import { SessionId } from "../src/domain/brands.ts";
import {
  InvalidManifest,
  isTerminalFinalization,
  LeaseLost,
} from "../src/domain/errors.ts";
import {
  isExactPublishedObject,
  normalizeSha256Checksum,
} from "../src/domain/media.ts";

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
});
