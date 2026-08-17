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

import {
  TerminalFinalizationError as TerminalError,
  validateFinalizePlan as validateFinalizePlanImpl,
  validateManifest as validateManifestImpl,
} from "./domain/validate.ts";
export const TerminalFinalizationError = TerminalError;
export const validateFinalizePlan = validateFinalizePlanImpl;
export const validateManifest = validateManifestImpl;
