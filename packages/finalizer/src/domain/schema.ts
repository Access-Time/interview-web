import { Schema } from "effect";
import { SessionId, Sha256Hex } from "./brands.ts";

export const FinalizerPart = Schema.Struct({
  byteSize: Schema.Number,
  checksum: Sha256Hex,
  mediaType: Schema.optional(Schema.NullOr(Schema.String)),
  objectKey: Schema.String,
  sequence: Schema.Number,
});
export type FinalizerPart = typeof FinalizerPart.Type;

const FinalizerSegment = Schema.Struct({
  id: Schema.String,
  index: Schema.Number,
  parts: Schema.Array(FinalizerPart),
  recorderMimeType: Schema.optional(Schema.NullOr(Schema.String)),
  requestedMimeType: Schema.optional(Schema.NullOr(Schema.String)),
});

export const FinalizerManifest = Schema.Struct({
  segments: Schema.Array(FinalizerSegment),
  sessionId: SessionId,
});
export type FinalizerManifest = typeof FinalizerManifest.Type;

export const FinalizePlanEntry = Schema.Struct({
  partCount: Schema.Number,
  segmentId: Schema.String,
});
export type FinalizePlanEntry = typeof FinalizePlanEntry.Type;

export const FinalizePlan = Schema.Array(FinalizePlanEntry);
export type FinalizePlan = typeof FinalizePlan.Type;

export const PublishedObject = Schema.Struct({
  byteSize: Schema.Number,
  checksum: Sha256Hex,
  mediaType: Schema.String,
  objectKey: Schema.String,
});
export type PublishedObject = typeof PublishedObject.Type;
