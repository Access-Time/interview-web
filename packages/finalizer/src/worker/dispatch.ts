import { createDb } from "@interview-web/db";
import { Clock, Effect, Layer, Option, Schema } from "effect";
import { SessionId } from "../domain/brands.ts";
import type { FinalizerEnv } from "../worker.ts";
import { makeContainerClient } from "./container.ts";
import { FinalizerDb, makeFinalizerDb } from "./db.ts";
import { makePassthroughContainerClient } from "./passthrough.ts";
import { processFinalization } from "./process.ts";
import { FinalizationQueue, makeFinalizationQueue } from "./queue.ts";
import { makeRecordings } from "./recordings.ts";

const DISPATCH_PATH = "/internal/finalizations";
const DispatchBody = Schema.Struct({ sessionId: SessionId });

export const dispatchFinalization = Effect.fn("dispatchFinalization")(
  function* (request: Request) {
    if (request.method !== "POST") {
      return new Response(null, { status: 405 });
    }
    if (new URL(request.url).pathname !== DISPATCH_PATH) {
      return new Response(null, { status: 404 });
    }
    const body = yield* Effect.tryPromise(() => request.json()).pipe(
      Effect.flatMap((value) => Schema.decodeUnknown(DispatchBody)(value)),
      Effect.option
    );
    if (Option.isNone(body)) {
      return new Response(null, { status: 400 });
    }
    const queue = yield* FinalizationQueue;
    return yield* queue.send(body.value.sessionId).pipe(
      Effect.as(new Response(null, { status: 202 })),
      Effect.catchTag("QueueSendFailed", () =>
        Effect.succeed(new Response(null, { status: 503 }))
      )
    );
  }
);

export const handleQueueMessage = Effect.fn("handleQueueMessage")(function* (
  sessionId: SessionId
) {
  yield* processFinalization(sessionId).pipe(
    Effect.tapError((error) =>
      Effect.logError("Recording finalization failed", { error, sessionId })
    )
  );
});

export const reconciliationBatch = Effect.fn("reconciliationBatch")(
  function* () {
    const now = yield* Clock.currentTimeMillis;
    const db = yield* FinalizerDb;
    return yield* db.listDue(now, 20);
  }
);

export const WorkerLive = (env: FinalizerEnv) =>
  Layer.mergeAll(
    makeFinalizerDb(createDb(env.DB)),
    makeFinalizationQueue(env.FINALIZATION_QUEUE as unknown as Queue<unknown>),
    makeRecordings(env.RECORDINGS as R2Bucket),
    env.FINALIZER
      ? makeContainerClient(env.FINALIZER)
      : makePassthroughContainerClient()
  );
