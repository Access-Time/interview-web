import assert from "node:assert/strict";
import test from "node:test";
import {
  createLiveRecordingOutbox,
  isRetryableRecordingFailure,
  type RecordingPart,
} from "../src/recording/live-recording.ts";

const part: RecordingPart = {
  blob: new Blob(["hello"], { type: "video/webm" }),
  mediaType: "video/webm",
  segmentId: "segment",
  sequence: 3,
  sessionId: "session",
};
const STORAGE_ERROR = /storage unavailable/;

function harness(
  response: Response | Promise<Response> = new Response(null, { status: 201 })
) {
  const stored: RecordingPart[] = [];
  const deleted: RecordingPart[] = [];
  const calls: Request[] = [];
  const events: string[] = [];
  const store = {
    delete: (value: RecordingPart) => {
      events.push("delete");
      deleted.push(value);
      return Promise.resolve();
    },
    put: (value: RecordingPart) => {
      events.push("persist");
      stored.push(value);
      return Promise.resolve();
    },
  };
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    events.push("request");
    calls.push(
      new Request(new URL(input.toString(), "http://localhost"), init)
    );
    return await response;
  };
  return {
    box: createLiveRecordingOutbox(store, request),
    calls,
    deleted,
    events,
    stored,
  };
}

test("persists before PUT and deletes only after a 2xx response", async () => {
  const harnessed = harness();
  await harnessed.box.add(part);
  assert.equal(harnessed.stored.length, 1);
  assert.equal(harnessed.deleted.length, 1);
  assert.deepEqual(harnessed.events, ["persist", "request", "delete"]);
  assert.equal(harnessed.box.saveState, "healthy");
  assert.equal(
    harnessed.calls[0]?.url,
    "http://localhost/api/recordings/session/segments/segment/parts/3"
  );
});

test("retryable 503 retains the local part and reports retrying", async () => {
  const harnessed = harness(new Response("no", { status: 503 }));
  await harnessed.box.add(part);
  assert.equal(harnessed.stored.length, 1);
  assert.equal(harnessed.deleted.length, 0);
  assert.equal(harnessed.box.saveState, "retrying");
  harnessed.box.dispose();
});

test("network failures are classified retryable and report retrying", async () => {
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    { delete: () => Promise.resolve(), put: () => Promise.resolve() },
    () => {
      throw new Error("network unavailable");
    },
    (error) => errors.push(error)
  );
  await box.add(part);
  assert.equal(isRetryableRecordingFailure(errors[0]), true);
  assert.equal(box.saveState, "retrying");
  box.dispose();
});

test("uses exact blob checksum and upload headers", async () => {
  const harnessed = harness();
  await harnessed.box.add(part);
  const [request] = harnessed.calls;
  assert.ok(request);
  assert.equal(request.method, "PUT");
  assert.equal(request.headers.get("Content-Type"), "video/webm");
  assert.equal(
    request.headers.get("X-Content-SHA256"),
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
  assert.equal(await request.text(), "hello");
});

test("several parts can be persisted and uploaded while active", async () => {
  const harnessed = harness();
  await Promise.all(
    [1, 2, 3].map((sequence) => harnessed.box.add({ ...part, sequence }))
  );
  assert.equal(harnessed.stored.length, 3);
  assert.equal(harnessed.deleted.length, 3);
  assert.equal(harnessed.calls.length, 3);
});

test("a successful part does not clear retrying for another failed part", async () => {
  const requests: Request[] = [];
  const deleted: RecordingPart[] = [];
  const stored: RecordingPart[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: (value) => {
        deleted.push(value);
        return Promise.resolve();
      },
      put: (value) => {
        stored.push(value);
        return Promise.resolve();
      },
    },
    async (input, init) => {
      const request = new Request(
        new URL(input.toString(), "http://localhost"),
        init
      );
      requests.push(request);
      await Promise.resolve();
      return new Response(null, {
        status: request.url.endsWith("/1") ? 503 : 201,
      });
    }
  );
  await box.setOnline(false);
  await box.add({ ...part, sequence: 1 });
  await box.add({ ...part, sequence: 2 });
  await box.setOnline(true);
  assert.equal(requests.length, 2);
  assert.equal(stored.length, 2);
  assert.equal(deleted.length, 1);
  assert.equal(box.saveState, "retrying");
  box.dispose();
});

test("dispose prevents retry after an in-flight retryable failure", async () => {
  let rejectRequest!: (error: Error) => void;
  let resolveStarted!: () => void;
  let requests = 0;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const store = {
    delete: () => Promise.resolve(),
    put: () => Promise.resolve(),
  };
  const box = createLiveRecordingOutbox(store, () => {
    requests += 1;
    resolveStarted();
    return new Promise<Response>((_, reject) => {
      rejectRequest = reject;
    });
  });
  await box.setOnline(false);
  await box.add(part);
  const flushing = box.setOnline(true);
  await started;
  box.dispose();
  rejectRequest(new Error("network unavailable"));
  await flushing;
  await Promise.resolve();
  await Promise.resolve();
  assert.equal(requests, 1);
  assert.equal(box.pendingCount, 1);
});

test("persistence failures reject and never request", async () => {
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      put: () => {
        throw new Error("storage unavailable");
      },
    },
    fetch,
    (error) => errors.push(error)
  );
  await assert.rejects(box.add(part), STORAGE_ERROR);
  assert.equal((errors[0] as Error).message, "storage unavailable");
  assert.equal(isRetryableRecordingFailure(errors[0]), false);
  assert.equal(box.saveState, "error");
});

test("terminal upload failure is retained and does not retry when online", async () => {
  let requests = 0;
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    { delete: () => Promise.resolve(), put: () => Promise.resolve() },
    async () => {
      requests += 1;
      await Promise.resolve();
      return new Response(null, { status: 409 });
    },
    (error) => errors.push(error)
  );
  await box.add(part);
  await box.setOnline(false);
  await box.setOnline(true);
  assert.equal(requests, 1);
  assert.equal(box.pendingCount, 1);
  assert.equal(box.saveState, "error");
  assert.equal(errors.length, 1);
  box.dispose();
});
