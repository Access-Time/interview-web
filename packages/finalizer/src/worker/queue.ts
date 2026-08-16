import { Context, Effect, Layer } from "effect";
import type { SessionId } from "../domain/brands.ts";
import { QueueSendFailed } from "../domain/errors.ts";
export class FinalizationQueue extends Context.Tag("FinalizationQueue")<
  FinalizationQueue,
  {
    readonly send: (
      sessionId: SessionId
    ) => Effect.Effect<void, QueueSendFailed>;
  }
>() {}
export const makeFinalizationQueue = (
  queue: Queue<unknown>
): Layer.Layer<FinalizationQueue> =>
  Layer.succeed(FinalizationQueue, {
    send: (sessionId) =>
      Effect.tryPromise({
        catch: () => new QueueSendFailed({ message: "queue send failed" }),
        try: () => queue.send({ sessionId }),
      }),
  });
