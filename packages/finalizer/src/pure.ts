// biome-ignore lint/performance/noBarrelFile: legacy compatibility shim.
export {
  deterministicJobName,
  isExactFinalizerOutput,
  isExactPublishedObject,
  MAX_INPUT_BYTES,
  MAX_SEGMENTS,
  normalizeSha256Checksum,
  outputMediaType,
} from "./domain/media.ts";
export type { FinalizerManifest, FinalizerPart } from "./domain/schema.ts";

import { Effect } from "effect";
import { InvalidManifest } from "./domain/errors.ts";
import { decodeFinalizePlan, decodeManifest } from "./domain/validate.ts";
export const TerminalFinalizationError = InvalidManifest;
export const validateManifest = (manifest: unknown): number => {
  const decoded = Effect.runSync(decodeManifest(manifest));
  return decoded.segments.reduce(
    (total, segment) =>
      total + segment.parts.reduce((sum, part) => sum + part.byteSize, 0),
    0
  );
};
export const validateFinalizePlan = (manifest: unknown, planJson: unknown) =>
  Effect.runSync(
    decodeFinalizePlan(Effect.runSync(decodeManifest(manifest)), planJson)
  );
