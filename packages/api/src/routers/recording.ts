import { ORPCError } from "@orpc/server";
import z from "zod";
import type { RecordingBindings } from "../context.ts";
import { publicProcedure } from "../index.ts";

const sessionInput = z.object({
  recorderMimeType: z.string().nullable().optional(),
  requestedMimeType: z.string().nullable().optional(),
  segmentId: z.string().min(1),
  sessionId: z.string().min(1),
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

export const recordingRouter = {
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

  getManifest: publicProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const bindings = requireBindings(context);
      const manifest = await bindings.getRecordingManifest(input.sessionId);
      if (!manifest) {
        throw new ORPCError("NOT_FOUND");
      }
      return manifest;
    }),
};
