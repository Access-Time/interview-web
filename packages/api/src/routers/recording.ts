import { ORPCError } from "@orpc/server";
import z from "zod";
import type { RecordingBindings } from "../context.ts";
import { publicProcedure } from "../index.ts";

const sessionInput = z.object({
  recorderMimeType: z.string().nullable().optional(),
  requestedMimeType: z.string().nullable().optional(),
  segmentId: z.string().min(1).max(128),
  sessionId: z.string().min(1).max(128),
});
const recordingId = z.string().min(1).max(128);
const playbackCursor = z.object({
  createdAt: z.number().int().nonnegative(),
  id: recordingId,
});

const finalizeInput = z.object({
  segments: z
    .array(
      z.object({
        partCount: z.number().int().positive(),
        segmentId: recordingId,
      })
    )
    .min(1)
    .max(5)
    .superRefine((segments, context) => {
      if (
        new Set(segments.map(({ segmentId }) => segmentId)).size !==
        segments.length
      ) {
        context.addIssue({
          code: "custom",
          message: "segment IDs must be unique",
        });
      }
    }),
  sessionId: recordingId,
});

function requireBindings(context: { bindings: RecordingBindings | undefined }) {
  if (!context.bindings) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return context.bindings;
}

function isCreateRecordingSessionConflictError(error: unknown) {
  return (
    error instanceof Error &&
    error.name === "CreateRecordingSessionConflictError"
  );
}

function isAppendRecordingSegmentConflictError(error: unknown) {
  return (
    error instanceof Error &&
    error.name === "AppendRecordingSegmentConflictError"
  );
}

export const recordingRouter = {
  appendSegment: publicProcedure
    .input(sessionInput)
    .handler(async ({ input, context }) => {
      try {
        return await requireBindings(context).appendRecordingSegment(input);
      } catch (error) {
        if (isAppendRecordingSegmentConflictError(error)) {
          throw new ORPCError("CONFLICT", { cause: error });
        }
        throw error;
      }
    }),
  create: publicProcedure
    .input(sessionInput)
    .handler(async ({ input, context }) => {
      const bindings = requireBindings(context);
      try {
        return await bindings.createRecordingSession(input);
      } catch (error) {
        if (isCreateRecordingSessionConflictError(error)) {
          throw new ORPCError("CONFLICT", { cause: error });
        }
        throw error;
      }
    }),
  finalize: publicProcedure
    .input(finalizeInput)
    .handler(async ({ input, context }) => {
      try {
        const bindings = requireBindings(context);
        const result = await bindings.finalizeRecording(input);
        if (result.status === "queued") {
          await bindings.enqueueFinalization(input.sessionId);
        }
        return result;
      } catch (error) {
        if (error instanceof Error && error.name === "RecordingNotFoundError") {
          throw new ORPCError("NOT_FOUND", { cause: error });
        }
        if (
          error instanceof Error &&
          error.name === "RecordingFinalizeConflictError"
        ) {
          throw new ORPCError("CONFLICT", { cause: error });
        }
        throw error;
      }
    }),

  getManifest: publicProcedure
    .input(z.object({ sessionId: recordingId }))
    .handler(async ({ input, context }) => {
      const bindings = requireBindings(context);
      const manifest = await bindings.getRecordingManifest(input.sessionId);
      if (!manifest) {
        throw new ORPCError("NOT_FOUND");
      }
      return manifest;
    }),
  getPlaybackSummary: publicProcedure
    .input(z.object({ sessionId: recordingId }))
    .handler(async ({ input, context }) => {
      const summary = await requireBindings(
        context
      ).getRecordingPlaybackSummary(input.sessionId);
      if (!summary) {
        throw new ORPCError("NOT_FOUND");
      }
      return summary;
    }),
  getStatus: publicProcedure
    .input(z.object({ sessionId: recordingId }))
    .handler(async ({ input, context }) => {
      const status = await requireBindings(context).getRecordingStatus(
        input.sessionId
      );
      if (!status) {
        throw new ORPCError("NOT_FOUND");
      }
      return status;
    }),
  listPlaybackSummaries: publicProcedure
    .input(z.object({ cursor: playbackCursor.optional() }))
    .handler(({ input, context }) =>
      requireBindings(context).listRecordingPlaybackSummaries(input)
    ),
};
