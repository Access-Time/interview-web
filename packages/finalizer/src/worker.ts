import { Container, getContainer } from "@cloudflare/containers";
import {
  type Database,
  listRecordingsForFinalization,
} from "@interview-web/db";
import { Effect, Schema } from "effect";
import { SessionId } from "./domain/brands.ts";
import {
  dispatchFinalization,
  handleQueueMessage as handleQueueMessageEffect,
  reconciliationBatch as reconciliationBatchEffect,
  WorkerLive,
} from "./worker/dispatch.ts";
import { FinalizationQueue as FinalizationQueueEffect } from "./worker/queue.ts";

export type {
  FinalizerManifest,
  FinalizerPart,
} from "./pure";
// biome-ignore lint/performance/noBarrelFile: these exports are the package's public worker entrypoint.
export {
  deterministicJobName,
  isExactFinalizerOutput,
  isExactPublishedObject,
  normalizeSha256Checksum,
  outputMediaType,
  TerminalFinalizationError,
  validateFinalizePlan,
  validateManifest,
} from "./pure";
export type FinalizerDb = Database;
export interface FinalizerObject {
  body: ReadableStream<Uint8Array> | null;
  checksums?: { sha256?: ArrayBuffer | string };
  httpMetadata?: { contentType?: string };
  size: number;
}
export interface FinalizerBucket {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<FinalizerObject | null>;
  head: (key: string) => Promise<Omit<FinalizerObject, "body"> | null>;
  put: (
    key: string,
    value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
    options: Record<string, unknown>
  ) => Promise<Omit<FinalizerObject, "body"> | null>;
}
export interface FinalizerContainer {
  fetch: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>;
}

export class RecordingFinalizerContainer extends Container {
  defaultPort = 8080;
  sleepAfter = "10m";
  pingEndpoint = "container/health";
  enableInternet = false;

  override async onActivityExpired() {
    // Remove the instance instead of leaving a stopped container in Docker.
    await this.destroy();
  }
}

export function getFinalizerContainer(env: {
  FINALIZER: DurableObjectNamespace<RecordingFinalizerContainer>;
}) {
  // One instance: jobs stay isolated under /jobs/:id, and Alchemy caps this
  // class at maxInstances: 1. A name per attempt starts a new Durable Object
  // and a new local Docker container that workerd leaves stopped.
  return getContainer(env.FINALIZER);
}

export interface FinalizationQueue {
  send: (message: { sessionId: string }) => Promise<unknown>;
}
export interface FinalizerEnv {
  DB: D1Database;
  FINALIZATION_QUEUE: FinalizationQueue;
  FINALIZER?: DurableObjectNamespace<RecordingFinalizerContainer>;
  RECORDINGS: FinalizerBucket;
}

const FINALIZATION_DISPATCH_PATH = "/internal/finalizations";

export async function dispatchFinalizationRequest(
  request: Request,
  env: Pick<FinalizerEnv, "FINALIZATION_QUEUE">
): Promise<Response> {
  if (request.method !== "POST") {
    return new Response(null, { status: 405 });
  }

  if (new URL(request.url).pathname !== FINALIZATION_DISPATCH_PATH) {
    return new Response(null, { status: 404 });
  }

  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return new Response(null, { status: 400 });
  }

  if (
    !body ||
    typeof body !== "object" ||
    Array.isArray(body) ||
    !("sessionId" in body) ||
    typeof body.sessionId !== "string" ||
    body.sessionId.length < 1 ||
    body.sessionId.length > 128
  ) {
    return new Response(null, { status: 400 });
  }

  try {
    await env.FINALIZATION_QUEUE.send({ sessionId: body.sessionId });
  } catch {
    return new Response(null, { status: 503 });
  }

  return new Response(null, { status: 202 });
}

export async function reconciliationBatch(db: FinalizerDb) {
  return (await listRecordingsForFinalization(db, Date.now(), 20)).map(
    (sessionId) => ({ sessionId })
  );
}
export default {
  fetch(request: Request, env: FinalizerEnv) {
    return Effect.runPromise(
      dispatchFinalization(request).pipe(Effect.provide(WorkerLive(env)))
    );
  },
  async queue(
    batch: {
      messages: Array<{ body: { sessionId: string }; ack: () => void }>;
    },
    env: FinalizerEnv
  ) {
    for (const message of batch.messages) {
      // biome-ignore lint/performance/noAwaitInLoops: queue messages are processed one at a time to preserve finalization ordering.
      await Effect.runPromise(
        handleQueueMessageEffect(
          Schema.decodeUnknownSync(SessionId)(message.body.sessionId)
        ).pipe(
          Effect.provide(WorkerLive(env)),
          Effect.tap(() => Effect.sync(() => message.ack()))
        )
      );
    }
  },
  async scheduled(_event: ScheduledEvent, env: FinalizerEnv) {
    await Effect.runPromise(
      reconciliationBatchEffect().pipe(
        Effect.flatMap((ids) =>
          Effect.forEach(
            ids,
            (id) =>
              Effect.flatMap(FinalizationQueueEffect, (queue) =>
                queue.send(id)
              ),
            {
              discard: true,
            }
          )
        ),
        Effect.provide(WorkerLive(env))
      )
    );
  },
};
