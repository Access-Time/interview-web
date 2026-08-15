import { Container, getContainer } from "@cloudflare/containers";
import {
  claimRecordingFinalization,
  completeRecordingFinalization,
  createDb,
  type Database,
  failRecordingFinalization,
  getReadyRecordingSubmission,
  listRecordingsForFinalization,
  releaseRecordingFinalizationForRetry,
  renewRecordingFinalizationLease,
} from "@interview-web/db";
import {
  deterministicJobName,
  isExactFinalizerOutput,
  outputMediaType,
  TerminalFinalizationError,
  validateFinalizePlan,
  validateManifest,
} from "./pure";

const CHECKSUM = /^[a-f\d]{64}$/;

export type {
  FinalizerManifest,
  FinalizerPart,
} from "./pure";
// biome-ignore lint/performance/noBarrelFile: these exports are the package's public worker entrypoint.
export {
  deterministicJobName,
  isExactFinalizerOutput,
  outputMediaType,
  TerminalFinalizationError,
  validateFinalizePlan,
  validateManifest,
} from "./pure";
export type FinalizerDb = Database;
export interface FinalizerObject {
  body: ReadableStream<Uint8Array> | null;
  checksums?: { sha256?: ArrayBuffer };
  httpMetadata?: { contentType?: string };
  size: number;
}
export interface FinalizerBucket {
  delete: (key: string) => Promise<void>;
  get: (key: string) => Promise<FinalizerObject | null>;
  head: (key: string) => Promise<Omit<FinalizerObject, "body"> | null>;
  put: (
    key: string,
    value: ReadableStream<Uint8Array>,
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

export function getFinalizerContainer(env: Pick<FinalizerEnv, "FINALIZER">) {
  // One instance: jobs stay isolated under /jobs/:id, and Alchemy caps this
  // class at maxInstances: 1. A name per attempt starts a new Durable Object
  // and a new local Docker container that workerd leaves stopped.
  return getContainer(env.FINALIZER);
}

function hex(bytes: ArrayBuffer) {
  return [...new Uint8Array(bytes)]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
export async function sha256(stream: ReadableStream<Uint8Array>) {
  const chunks: Uint8Array[] = [];
  const reader = stream.getReader();
  let size = 0;
  for (;;) {
    // biome-ignore lint/performance/noAwaitInLoops: stream reads are inherently sequential.
    const n = await reader.read();
    if (n.done) {
      break;
    }
    chunks.push(n.value);
    size += n.value.byteLength;
  }
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return hex(await crypto.subtle.digest("SHA-256", bytes));
}
class TransientFinalizationError extends Error {
  terminal = false;
}
export function isTerminalFinalizationStatus(status: number) {
  return [400, 413, 415, 422].includes(status);
}
export function check(response: Response, what: string) {
  if (response.ok) {
    return response;
  }
  if (isTerminalFinalizationStatus(response.status)) {
    throw new TerminalFinalizationError(`${what}: ${response.status}`);
  }
  throw new TransientFinalizationError(`${what}: ${response.status}`);
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: ordered finalization protocol.
export async function processFinalization(input: {
  db: FinalizerDb;
  recordings: FinalizerBucket;
  containerForAttempt: (
    attempt: number
  ) => FinalizerContainer | Promise<FinalizerContainer>;
  sessionId: string;
  dbFns?: Partial<DbFns>;
  heartbeatMs?: number;
}) {
  const f = { ...defaultDbFns, ...input.dbFns };
  const claimed = await f.claim(input.db, input.sessionId);
  if (!claimed) {
    return;
  }
  const { attempt, manifest } = claimed;
  let outputKey: string | undefined;
  let candidateOutput:
    | {
        objectKey: string;
        mediaType: string;
        byteSize: number;
        checksum: string;
      }
    | undefined;
  let published = false;
  let leaseLost = false;
  const abort = new AbortController();
  const renew = async () => {
    if (
      leaseLost ||
      !(await f.renew(input.db, { attempt, sessionId: input.sessionId }))
    ) {
      leaseLost = true;
      abort.abort();
      throw new TransientFinalizationError("finalization lease lost");
    }
  };
  const timer = setInterval(() => {
    f.renew(input.db, { attempt, sessionId: input.sessionId }).then(
      (ok) => {
        if (!ok) {
          leaseLost = true;
          abort.abort();
        }
      },
      () => {
        leaseLost = true;
        abort.abort();
      }
    );
  }, input.heartbeatMs ?? 60_000);
  let container: FinalizerContainer | undefined;
  try {
    validateManifest(manifest);
    validateFinalizePlan(manifest, claimed.finalizePlan);
    await renew();
    container = await input.containerForAttempt(attempt);
    const job = await deterministicJobName(input.sessionId, attempt);
    const activeContainer = container;
    // Local miniflare Container.fetch uses the standard URL parser and rejects
    // relative paths. Production accepts them; resolve against a dummy origin.
    const fetch = (url: string, init: RequestInit = {}) =>
      activeContainer.fetch(new URL(url, "http://container"), {
        ...init,
        signal: abort.signal,
      });
    const plan = manifest.segments.map((s) => ({
      partIndexes: s.parts.map((p) => p.sequence),
      segmentIndex: s.index,
    }));
    for (const segment of manifest.segments) {
      for (const part of segment.parts) {
        // biome-ignore lint/performance/noAwaitInLoops: media parts must upload in manifest order.
        await renew();
        const object = await input.recordings.get(part.objectKey);
        if (
          !object?.body ||
          object.size !== part.byteSize ||
          !object.checksums?.sha256 ||
          hex(object.checksums.sha256) !== part.checksum.toLowerCase()
        ) {
          throw new TerminalFinalizationError("missing or corrupt part");
        }
        const r = await fetch(
          `/jobs/${job}/parts/${segment.index}/${part.sequence}`,
          {
            body: object.body,
            headers: {
              "content-length": String(part.byteSize),
              "x-content-sha256": part.checksum,
            },
            method: "PUT",
          }
        );
        check(r, "part upload");
        await renew();
      }
    }
    await renew();
    check(
      await fetch(`/jobs/${job}/finalize`, {
        body: JSON.stringify({
          outputMediaType: outputMediaType(manifest),
          segments: plan,
        }),
        headers: { "content-type": "application/json" },
        method: "POST",
      }),
      "finalize"
    );
    await renew();
    const out = check(await fetch(`/jobs/${job}/output`), "output");
    await renew();
    const type = out.headers.get("content-type");
    const size = Number(out.headers.get("content-length"));
    const checksum = out.headers.get("x-content-sha256")?.toLowerCase();
    if (
      (type !== "video/webm" && type !== "video/mp4") ||
      !Number.isSafeInteger(size) ||
      size <= 0 ||
      !checksum ||
      !CHECKSUM.test(checksum) ||
      !out.body
    ) {
      throw new TerminalFinalizationError("invalid output");
    }
    outputKey = `recordings/${encodeURIComponent(input.sessionId)}/finalizations/attempt-${attempt}/output.${type === "video/mp4" ? "mp4" : "webm"}`;
    candidateOutput = {
      byteSize: size,
      checksum,
      mediaType: type,
      objectKey: outputKey,
    };
    const exact = (meta: Omit<FinalizerObject, "body"> | null) =>
      !!meta &&
      meta.size === size &&
      hex(meta.checksums?.sha256 ?? new ArrayBuffer(0)) === checksum &&
      meta.httpMetadata?.contentType === type;
    let written: Omit<FinalizerObject, "body"> | null = null;
    try {
      written = await input.recordings.put(outputKey, out.body, {
        httpMetadata: { contentType: type },
        onlyIf: { etagDoesNotMatch: "*" },
        sha256: checksum,
      });
    } catch {
      /* verify collision or partial publication below */
    }
    if (written === null && !exact(await input.recordings.head(outputKey))) {
      throw new TransientFinalizationError("output publication not proven");
    }
    if (written !== null && !exact(written)) {
      throw new TransientFinalizationError(
        "output publication metadata mismatch"
      );
    }
    if (leaseLost) {
      throw new TransientFinalizationError("finalization lease lost");
    }
    published = await f.complete(input.db, {
      attempt,
      output: {
        byteSize: size,
        checksum,
        mediaType: type,
        objectKey: outputKey,
      },
      sessionId: input.sessionId,
    });
    if (!published) {
      const ready = await f.ready(input.db, input.sessionId);
      if (
        !(candidateOutput && isExactFinalizerOutput(candidateOutput, ready))
      ) {
        await input.recordings.delete(outputKey);
      }
    }
  } catch (e) {
    if (e instanceof TerminalFinalizationError) {
      await f.fail(input.db, {
        attempt,
        failureCode: e.message,
        sessionId: input.sessionId,
      });
    } else {
      await f.release(input.db, { attempt, sessionId: input.sessionId });
      if (outputKey) {
        try {
          const ready = await f.ready(input.db, input.sessionId);
          if (
            !(candidateOutput && isExactFinalizerOutput(candidateOutput, ready))
          ) {
            await input.recordings.delete(outputKey);
          }
        } catch {
          /* cleanup is best effort */
        }
      }
      throw e;
    }
  } finally {
    clearInterval(timer);
    if (container) {
      try {
        await container.fetch(
          new URL(
            `/jobs/${await deterministicJobName(input.sessionId, attempt)}`,
            "http://container"
          ),
          {
            method: "DELETE",
          }
        );
      } catch {
        /* best effort */
      }
    }
  }
}

const defaultDbFns = {
  claim: claimRecordingFinalization,
  complete: completeRecordingFinalization,
  fail: failRecordingFinalization,
  ready: getReadyRecordingSubmission,
  release: releaseRecordingFinalizationForRetry,
  renew: renewRecordingFinalizationLease,
};
type DbFns = typeof defaultDbFns;
export interface FinalizationQueue {
  send: (message: { sessionId: string }) => Promise<unknown>;
}
export interface FinalizerEnv {
  DB: D1Database;
  FINALIZATION_QUEUE: FinalizationQueue;
  FINALIZER: DurableObjectNamespace<RecordingFinalizerContainer>;
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

export async function handleQueueMessage(
  message: { body: { sessionId: string }; ack?: () => void },
  env: FinalizerEnv
) {
  try {
    await processFinalization({
      containerForAttempt: () => getFinalizerContainer(env),
      db: createDb(env.DB),
      recordings: env.RECORDINGS,
      sessionId: message.body.sessionId,
    });
  } catch (error) {
    console.error("Recording finalization failed", {
      error,
      sessionId: message.body.sessionId,
    });
    throw error;
  }
  message.ack?.();
}

export async function reconciliationBatch(db: FinalizerDb) {
  return (await listRecordingsForFinalization(db, Date.now(), 20)).map(
    (sessionId) => ({ sessionId })
  );
}
export default {
  fetch(request: Request, env: FinalizerEnv) {
    return dispatchFinalizationRequest(request, env);
  },
  async queue(
    batch: {
      messages: Array<{ body: { sessionId: string }; ack: () => void }>;
    },
    env: FinalizerEnv
  ) {
    for (const message of batch.messages) {
      // biome-ignore lint/performance/noAwaitInLoops: queue messages are processed one at a time to preserve finalization ordering.
      await handleQueueMessage(message, env);
    }
  },
  async scheduled(_event: ScheduledEvent, env: FinalizerEnv) {
    for (const message of await reconciliationBatch(createDb(env.DB))) {
      // biome-ignore lint/performance/noAwaitInLoops: queue sends are intentionally ordered and bounded.
      await env.FINALIZATION_QUEUE.send(message);
    }
  },
};
