import type { RouterClient } from "@orpc/server";
import { publicProcedure } from "../index";
import { recordingRouter } from "./recording";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => "OK"),
  recording: recordingRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
