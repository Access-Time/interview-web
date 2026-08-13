export interface RecordingSubmissionMetadata {
  contentType?: string | null;
  httpEtag: string;
  size: number;
}

export interface RecordingSubmissionObject extends RecordingSubmissionMetadata {
  body: ReadableStream<Uint8Array>;
}

export interface RecordingSubmissionStorage {
  delete: (key: string) => Promise<void>;
  get: (
    key: string,
    range?: { offset: number; length: number }
  ) => Promise<RecordingSubmissionObject | null>;
  head: (key: string) => Promise<RecordingSubmissionMetadata | null>;
  list: (
    prefix: string,
    cursor?: string
  ) => Promise<{
    objects: Array<{ key: string }>;
    truncated: boolean;
    cursor?: string;
  }>;
}

export interface RecordingSubmissionBindings {
  beginDeletion: (sessionId: string) => Promise<{
    state: "missing" | "deleting";
    activeLeaseExpiresAt: number | null;
  }>;
  completeDeletion: (sessionId: string) => Promise<boolean>;
  getReadySubmission: (sessionId: string) => Promise<{
    objectKey: string;
    contentType?: string | null;
  } | null>;
  storage: RecordingSubmissionStorage;
}

const MAX_SWEEP_PAGES = 10_000;
const RANGE_PATTERN = /^bytes=(\d*)-(\d*)$/;
const prefixFor = (sessionId: string) =>
  `recordings/${encodeURIComponent(sessionId)}/`;

function parseRange(value: string, size: number): [number, number] | null {
  const match = RANGE_PATTERN.exec(value.trim());
  if (!(match && (match[1] || match[2]))) {
    return null;
  }
  let start: number;
  let end: number;
  if (match[1]) {
    start = Number(match[1]);
    end = match[2] ? Number(match[2]) : size - 1;
    if (!(Number.isSafeInteger(start) && Number.isSafeInteger(end))) {
      return null;
    }
    end = Math.min(end, size - 1);
  } else {
    const suffix = Number(match[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) {
      return null;
    }
    start = Math.max(0, size - suffix);
    end = size - 1;
  }
  return start <= end && start < size ? [start, end] : null;
}

function headersFor(
  metadata: RecordingSubmissionMetadata,
  contentType?: string | null
) {
  const headers = new Headers({
    "Accept-Ranges": "bytes",
    "Content-Length": String(metadata.size),
    ETag: metadata.httpEtag,
  });
  const type = contentType ?? metadata.contentType;
  if (type) {
    headers.set("Content-Type", type);
  }
  return headers;
}

async function sweep(
  prefix: string,
  storage: RecordingSubmissionStorage
): Promise<boolean> {
  let cursor: string | undefined;
  const seenCursors = new Set<string>();
  for (let pageNumber = 0; pageNumber < MAX_SWEEP_PAGES; pageNumber += 1) {
    if (cursor !== undefined) {
      if (seenCursors.has(cursor)) {
        throw new Error("pagination made no bounded progress");
      }
      seenCursors.add(cursor);
    }
    // biome-ignore lint/performance/noAwaitInLoops: pagination must remain sequential and cursor-safe.
    const page = await storage.list(prefix, cursor);
    if (page.truncated && page.cursor === undefined) {
      throw new Error("invalid pagination");
    }
    const keys = page.objects.filter(({ key }) => key.startsWith(prefix));
    for (const { key } of keys) {
      // biome-ignore lint/performance/noAwaitInLoops: deletion order is intentionally serialized.
      await storage.delete(key);
    }
    if (keys.length === 0 && !page.truncated) {
      return true;
    }
    cursor = page.truncated ? page.cursor : undefined;
  }
  throw new Error("pagination made no bounded progress");
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: preserve the existing response semantics in one handler.
export async function handleRecordingSubmission(
  request: Request,
  params: { sessionId: string },
  bindings: RecordingSubmissionBindings
): Promise<Response> {
  if (request.method === "DELETE") {
    try {
      const deletion = await bindings.beginDeletion(params.sessionId);
      if (deletion.state === "missing") {
        await sweep(prefixFor(params.sessionId), bindings.storage);
        return new Response(null, { status: 204 });
      }
      if (
        deletion.activeLeaseExpiresAt !== null &&
        deletion.activeLeaseExpiresAt > Date.now()
      ) {
        return new Response(null, { status: 202 });
      }
      await sweep(prefixFor(params.sessionId), bindings.storage);
      return (await bindings.completeDeletion(params.sessionId))
        ? new Response(null, { status: 204 })
        : new Response(null, { status: 202 });
    } catch {
      return new Response(null, { status: 500 });
    }
  }

  if (request.method !== "GET" && request.method !== "HEAD") {
    return new Response(null, { status: 405 });
  }
  try {
    const ready = await bindings.getReadySubmission(params.sessionId);
    if (!ready) {
      return new Response(null, { status: 404 });
    }
    const metadata = await bindings.storage.head(ready.objectKey);
    if (!metadata) {
      return new Response(null, { status: 503 });
    }
    const rangeHeader = request.headers.get("Range");
    const range = rangeHeader ? parseRange(rangeHeader, metadata.size) : null;
    if (rangeHeader && !range) {
      const headers = headersFor(metadata, ready.contentType);
      headers.set("Content-Range", `bytes */${metadata.size}`);
      headers.set("Content-Length", "0");
      return new Response(null, { headers, status: 416 });
    }
    if (range) {
      const [start, end] = range;
      const headers = headersFor(metadata, ready.contentType);
      headers.set("Content-Range", `bytes ${start}-${end}/${metadata.size}`);
      headers.set("Content-Length", String(end - start + 1));
      if (request.method === "HEAD") {
        return new Response(null, { headers, status: 206 });
      }
      const object = await bindings.storage.get(ready.objectKey, {
        length: end - start + 1,
        offset: start,
      });
      if (!object) {
        return new Response(null, { status: 503 });
      }
      return new Response(object.body, { headers, status: 206 });
    }
    const headers = headersFor(metadata, ready.contentType);
    if (request.method === "HEAD") {
      return new Response(null, { headers, status: 200 });
    }
    const object = await bindings.storage.get(ready.objectKey);
    if (!object) {
      return new Response(null, { status: 503 });
    }
    return new Response(object.body, { headers, status: 200 });
  } catch {
    return new Response(null, { status: 500 });
  }
}
