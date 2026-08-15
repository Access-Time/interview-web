import { createDb } from "@interview-web/db";
import { env } from "@interview-web/env/server";
import { os } from "@orpc/server";

export const withDatabase = os.middleware(({ next }) =>
  next({ context: { db: createDb() } })
);

export const withFinalizer = os.middleware(({ next }) =>
  next({
    context: {
      finalizer: env.FINALIZER,
    },
  })
);
