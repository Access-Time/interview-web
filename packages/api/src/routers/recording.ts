import { recordingProcedure } from "../index.ts";
import { throwServiceError } from "../throw-service-error.ts";
import {
  finalizeInputDto,
  listPlaybackSummariesInputDto,
  sessionIdInputDto,
  sessionInputDto,
} from "./recording.dto.ts";
import {
  appendSegmentErrors,
  createRecordingErrors,
  finalizeRecordingErrors,
  getRecordingErrors,
} from "./recording.error.ts";
import {
  appendSegment,
  createRecording,
  finalizeSession,
  getManifest,
  getPlaybackSummary,
  getStatus,
  listPlaybackSummaries,
} from "./recording.service.ts";

export const recordingRouter = {
  appendSegment: recordingProcedure
    .errors(appendSegmentErrors)
    .input(sessionInputDto)
    .handler(async ({ context, errors, input }) => {
      const result = await appendSegment(context.db, input);
      if (!result.ok) {
        return throwServiceError(errors, result.error);
      }
      return result.data;
    }),
  create: recordingProcedure
    .errors(createRecordingErrors)
    .input(sessionInputDto)
    .handler(async ({ context, errors, input }) => {
      const result = await createRecording(context.db, input);
      if (!result.ok) {
        return throwServiceError(errors, result.error);
      }
      return result.data;
    }),
  finalize: recordingProcedure
    .errors(finalizeRecordingErrors)
    .input(finalizeInputDto)
    .handler(async ({ context, errors, input }) => {
      const result = await finalizeSession(
        { db: context.db, finalizer: context.finalizer },
        input
      );
      if (!result.ok) {
        return throwServiceError(errors, result.error);
      }
      return result.data;
    }),
  getManifest: recordingProcedure
    .errors(getRecordingErrors)
    .input(sessionIdInputDto)
    .handler(async ({ context, errors, input }) => {
      const result = await getManifest(context.db, input);
      if (!result.ok) {
        return throwServiceError(errors, result.error);
      }
      return result.data;
    }),
  getPlaybackSummary: recordingProcedure
    .errors(getRecordingErrors)
    .input(sessionIdInputDto)
    .handler(async ({ context, errors, input }) => {
      const result = await getPlaybackSummary(context.db, input);
      if (!result.ok) {
        return throwServiceError(errors, result.error);
      }
      return result.data;
    }),
  getStatus: recordingProcedure
    .errors(getRecordingErrors)
    .input(sessionIdInputDto)
    .handler(async ({ context, errors, input }) => {
      const result = await getStatus(context.db, input);
      if (!result.ok) {
        return throwServiceError(errors, result.error);
      }
      return result.data;
    }),
  listPlaybackSummaries: recordingProcedure
    .input(listPlaybackSummariesInputDto)
    .handler(({ context, input }) => listPlaybackSummaries(context.db, input)),
};
