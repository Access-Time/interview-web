import { ORPCError } from "@orpc/server";
import z from "zod";
import type { RecordingBindings } from "../context.ts";
import { publicProcedure } from "../index.ts";

const sessionInput = z.object({
  segmentId: z.string().min(1),
  sessionId: z.string().min(1),
});

function requireOperator(context: {
  bindings: RecordingBindings | undefined;
  operatorAuthorized: boolean;
}) {
  if (!(context.operatorAuthorized && context.bindings)) {
    throw new ORPCError("UNAUTHORIZED");
  }
  return context.bindings;
}

export const recordingRouter = {
  create: publicProcedure
    .input(sessionInput)
    .handler(async ({ input, context }) => {
      const bindings = requireOperator(context);
      return await bindings.createRecordingSession(input);
    }),

  getManifest: publicProcedure
    .input(z.object({ sessionId: z.string().min(1) }))
    .handler(async ({ input, context }) => {
      const bindings = requireOperator(context);
      const manifest = await bindings.getRecordingManifest(input.sessionId);
      if (!manifest) {
        throw new ORPCError("NOT_FOUND");
      }
      return manifest;
    }),
};
