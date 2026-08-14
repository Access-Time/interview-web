import z from "zod";
import type { ErrorSchema, ServiceError } from "../types.ts";

export const recordingErrors = {
  FINALIZE_CONFLICT: {
    message: "This recording cannot be finalized with the submitted segments",
    status: 409,
  },
  RECORDING_NOT_FOUND: {
    data: z.object({ sessionId: z.string() }),
    message: "Recording not found",
    status: 404,
  },
  SEGMENT_CONFLICT: {
    data: z.object({
      segmentId: z.string(),
      sessionId: z.string(),
    }),
    message: "This recording segment conflicts with the existing session",
    status: 409,
  },
  SESSION_CONFLICT: {
    data: z.object({
      segmentId: z.string(),
      sessionId: z.string(),
    }),
    message: "This recording session already exists",
    status: 409,
  },
} satisfies ErrorSchema;

export const createRecordingErrors = {
  SESSION_CONFLICT: recordingErrors.SESSION_CONFLICT,
} satisfies ErrorSchema;

export type CreateRecordingServiceError = ServiceError<
  typeof createRecordingErrors
>;

export const appendSegmentErrors = {
  SEGMENT_CONFLICT: recordingErrors.SEGMENT_CONFLICT,
} satisfies ErrorSchema;

export type AppendSegmentServiceError = ServiceError<
  typeof appendSegmentErrors
>;

export const finalizeRecordingErrors = {
  FINALIZE_CONFLICT: recordingErrors.FINALIZE_CONFLICT,
  RECORDING_NOT_FOUND: recordingErrors.RECORDING_NOT_FOUND,
} satisfies ErrorSchema;

export type FinalizeRecordingServiceError = ServiceError<
  typeof finalizeRecordingErrors
>;

export const getRecordingErrors = {
  RECORDING_NOT_FOUND: recordingErrors.RECORDING_NOT_FOUND,
} satisfies ErrorSchema;

export type GetRecordingServiceError = ServiceError<typeof getRecordingErrors>;
