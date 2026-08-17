import {
  AppendRecordingSegmentConflictError,
  type AppendRecordingSegmentResult,
  appendRecordingSegment,
  CreateRecordingSessionConflictError,
  type CreateRecordingSessionResult,
  createRecordingSession,
  type Database,
  finalizeRecording,
  getRecordingManifest,
  getRecordingPlaybackSummary,
  getRecordingStatus,
  listRecordingPlaybackSummaries,
  RecordingFinalizeConflictError,
  type RecordingFinalizeResult,
  type RecordingManifest,
  RecordingNotFoundError,
  type RecordingPlaybackPage,
  type RecordingPlaybackSummary,
  type RecordingStatus,
} from "@interview-web/db";
import {
  dispatchFinalization,
  type FinalizerDispatcher,
} from "../finalizer.ts";
import { err, ok, type ServiceResult } from "../result.ts";
import type {
  FinalizeInputDto,
  ListPlaybackSummariesInputDto,
  SessionIdInputDto,
  SessionInputDto,
} from "./recording.dto.ts";
import type {
  AppendSegmentServiceError,
  CreateRecordingServiceError,
  FinalizeRecordingServiceError,
  GetRecordingServiceError,
} from "./recording.error.ts";

function isErrorName(error: unknown, name: string) {
  return error instanceof Error && error.name === name;
}

export const createRecording = async (
  db: Database,
  input: SessionInputDto
): Promise<
  ServiceResult<CreateRecordingSessionResult, CreateRecordingServiceError>
> => {
  try {
    return ok(await createRecordingSession(db, input));
  } catch (error) {
    if (
      error instanceof CreateRecordingSessionConflictError ||
      isErrorName(error, "CreateRecordingSessionConflictError")
    ) {
      return err({
        cause: error,
        data: { segmentId: input.segmentId, sessionId: input.sessionId },
        type: "SESSION_CONFLICT",
      });
    }
    throw error;
  }
};

export const appendSegment = async (
  db: Database,
  input: SessionInputDto
): Promise<
  ServiceResult<AppendRecordingSegmentResult, AppendSegmentServiceError>
> => {
  try {
    return ok(await appendRecordingSegment(db, input));
  } catch (error) {
    if (
      error instanceof AppendRecordingSegmentConflictError ||
      isErrorName(error, "AppendRecordingSegmentConflictError")
    ) {
      return err({
        cause: error,
        data: { segmentId: input.segmentId, sessionId: input.sessionId },
        type: "SEGMENT_CONFLICT",
      });
    }
    throw error;
  }
};

export const finalizeSession = async (
  context: { db: Database; finalizer: FinalizerDispatcher },
  input: FinalizeInputDto
): Promise<
  ServiceResult<RecordingFinalizeResult, FinalizeRecordingServiceError>
> => {
  let result: RecordingFinalizeResult;
  try {
    result = await finalizeRecording(context.db, input);
  } catch (error) {
    if (
      error instanceof RecordingNotFoundError ||
      isErrorName(error, "RecordingNotFoundError")
    ) {
      return err({
        cause: error,
        data: { sessionId: input.sessionId },
        type: "RECORDING_NOT_FOUND",
      });
    }
    if (
      error instanceof RecordingFinalizeConflictError ||
      isErrorName(error, "RecordingFinalizeConflictError")
    ) {
      return err({
        cause: error,
        type: "FINALIZE_CONFLICT",
      });
    }
    throw error;
  }
  if (result.status === "queued" || result.status === "finalizing") {
    try {
      await dispatchFinalization(context.finalizer, input.sessionId);
    } catch (error) {
      console.error("Recording finalization dispatch failed", {
        error,
        sessionId: input.sessionId,
      });
    }
  }
  return ok(result);
};

export const getManifest = async (
  db: Database,
  input: SessionIdInputDto
): Promise<ServiceResult<RecordingManifest, GetRecordingServiceError>> => {
  const manifest = await getRecordingManifest(db, input.sessionId);
  if (!manifest) {
    return err({
      data: { sessionId: input.sessionId },
      type: "RECORDING_NOT_FOUND",
    });
  }
  return ok(manifest);
};

export const getStatus = async (
  db: Database,
  input: SessionIdInputDto
): Promise<ServiceResult<RecordingStatus, GetRecordingServiceError>> => {
  const status = await getRecordingStatus(db, input.sessionId);
  if (!status) {
    return err({
      data: { sessionId: input.sessionId },
      type: "RECORDING_NOT_FOUND",
    });
  }
  return ok(status);
};

export const getPlaybackSummary = async (
  db: Database,
  input: SessionIdInputDto
): Promise<
  ServiceResult<RecordingPlaybackSummary, GetRecordingServiceError>
> => {
  const summary = await getRecordingPlaybackSummary(db, input.sessionId);
  if (!summary) {
    return err({
      data: { sessionId: input.sessionId },
      type: "RECORDING_NOT_FOUND",
    });
  }
  return ok(summary);
};

export const listPlaybackSummaries = (
  db: Database,
  input: ListPlaybackSummariesInputDto
): Promise<RecordingPlaybackPage> => listRecordingPlaybackSummaries(db, input);
