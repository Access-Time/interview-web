import { os } from "@orpc/server";
import type { Context } from "./context.ts";
import { withDatabase, withFinalizer } from "./middlewares.ts";

export const o = os.$context<Context>();

export const publicProcedure = o;

export const recordingProcedure = publicProcedure
  .use(withDatabase)
  .use(withFinalizer);
