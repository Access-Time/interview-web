import type { RouterClient } from "@orpc/server";
import { publicProcedure } from "../index";
import { recordingRouter } from "./recording";
import { todoRouter } from "./todo";

export const appRouter = {
  healthCheck: publicProcedure.handler(() => "OK"),
  recording: recordingRouter,
  todo: todoRouter,
};
export type AppRouter = typeof appRouter;
export type AppRouterClient = RouterClient<typeof appRouter>;
