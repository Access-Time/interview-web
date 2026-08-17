import { Effect, Schema } from "effect";
import {
  IncompleteManifest,
  InputTooLarge,
  InvalidFinalizePlan,
  InvalidManifest,
  InvalidPart,
} from "./errors.ts";
import { MAX_INPUT_BYTES, MAX_SEGMENTS } from "./media.ts";
import { FinalizePlan, FinalizerManifest } from "./schema.ts";

export function decodeManifest(
  input: unknown
): Effect.Effect<
  FinalizerManifest,
  InvalidManifest | IncompleteManifest | InvalidPart | InputTooLarge
> {
  return Effect.gen(function* () {
    const manifest = yield* Schema.decodeUnknown(FinalizerManifest)(input).pipe(
      Effect.mapError(
        () => new InvalidManifest({ message: "invalid manifest" })
      )
    );
    if (
      manifest.segments.length === 0 ||
      manifest.segments.length > MAX_SEGMENTS
    ) {
      return yield* Effect.fail(
        new InvalidManifest({ message: "invalid manifest" })
      );
    }
    let total = 0;
    for (const [segmentIndex, segment] of manifest.segments.entries()) {
      if (segment.index !== segmentIndex || segment.parts.length === 0) {
        return yield* Effect.fail(
          new IncompleteManifest({ message: "incomplete manifest" })
        );
      }
      for (const [partIndex, part] of segment.parts.entries()) {
        if (
          part.sequence !== partIndex ||
          !Number.isSafeInteger(part.byteSize) ||
          part.byteSize <= 0 ||
          !part.objectKey
        ) {
          return yield* Effect.fail(
            new InvalidPart({ message: "invalid part" })
          );
        }
        total += part.byteSize;
      }
    }
    if (total > MAX_INPUT_BYTES) {
      return yield* Effect.fail(
        new InputTooLarge({ message: "input too large" })
      );
    }
    return manifest;
  });
}

export function decodeFinalizePlan(
  manifest: FinalizerManifest,
  planJson: unknown
): Effect.Effect<FinalizePlan, InvalidFinalizePlan> {
  return Effect.gen(function* () {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(planJson));
    } catch {
      return yield* Effect.fail(
        new InvalidFinalizePlan({ message: "invalid finalization plan" })
      );
    }
    const plan = yield* Schema.decodeUnknown(FinalizePlan)(parsed).pipe(
      Effect.mapError(
        () => new InvalidFinalizePlan({ message: "finalization plan mismatch" })
      )
    );
    if (plan.length !== manifest.segments.length) {
      return yield* Effect.fail(
        new InvalidFinalizePlan({ message: "finalization plan mismatch" })
      );
    }
    for (const [index, entry] of plan.entries()) {
      const segment = manifest.segments[index];
      if (
        !segment ||
        entry.segmentId !== segment.id ||
        entry.partCount !== segment.parts.length
      ) {
        return yield* Effect.fail(
          new InvalidFinalizePlan({ message: "finalization plan mismatch" })
        );
      }
    }
    return plan;
  });
}

export function validateManifest(manifest: unknown): number {
  const decoded = Effect.runSync(decodeManifest(manifest));
  return decoded.segments.reduce(
    (total, segment) =>
      total + segment.parts.reduce((sum, part) => sum + part.byteSize, 0),
    0
  );
}

export function validateFinalizePlan(
  manifest: unknown,
  planJson: unknown
): FinalizePlan {
  const decodedManifest = Effect.runSync(decodeManifest(manifest));
  return Effect.runSync(decodeFinalizePlan(decodedManifest, planJson));
}

export const TerminalFinalizationError = InvalidManifest;
