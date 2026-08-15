import { afterEach, expect, it, vi } from "vitest";
import {
  createLiveRecordingOutbox,
  integrityMessage,
  isRetryableRecordingFailure,
  type RecordingManifestView,
  type RecordingPart,
  type RecordingSession,
  reconcileRecordingParts,
  recordingIntentMetadata,
  recordingRemoteAction,
} from "../src/recording/live-recording.ts";

const part: RecordingPart = {
  blob: new Blob(["hello"], { type: "video/webm" }),
  mediaType: "video/webm",
  segmentId: "segment",
  sequence: 3,
  sessionId: "session",
};
const STORAGE_ERROR = /storage unavailable/;
const PENDING_ERROR = /pending/i;
const UPLOAD_ERROR = /upload failed|pending/i;
const NETWORK_OR_PENDING_ERROR = /network unavailable|pending/i;
const AMBIGUOUS_UPLOAD_ERROR = /upload failed|pending|network/i;
const CONFLICT_FINALIZE_ERROR = /conflicting parts and cannot be finalized/;
const GAP_FINALIZE_ERROR = /missing ordered parts and cannot be finalized/;
const HELLO_CHECKSUM =
  "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const OTHER_CHECKSUM =
  "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";
const recordingSession: RecordingSession = {
  recorderMimeType: "video/webm",
  requestedMimeType: "video/webm",
  segments: [{ partCount: 4, segmentId: "segment" }],
  sessionId: "session",
  status: "recording",
};

function manifestParts(
  sequences: Array<{ checksum?: string; sequence: number }>
): RecordingManifestView {
  return {
    segments: [
      {
        id: "segment",
        parts: sequences.map((item) => ({
          checksum: item.checksum ?? HELLO_CHECKSUM,
          sequence: item.sequence,
        })),
      },
    ],
    sessionId: "session",
  };
}

function recoveryHarness(
  parts: RecordingPart[],
  session = recordingSession,
  storeOptions?: { deleteError?: Error; discardError?: Error }
) {
  const stored = [...parts];
  const sessions = [session];
  const deleted: RecordingPart[] = [];
  const calls: Request[] = [];
  const store = {
    delete: (value: RecordingPart) => {
      if (storeOptions?.deleteError) {
        return Promise.reject(storeOptions.deleteError);
      }
      deleted.push(value);
      const index = stored.findIndex(
        (item) =>
          item.segmentId === value.segmentId &&
          item.sequence === value.sequence &&
          item.sessionId === value.sessionId
      );
      if (index >= 0) {
        stored.splice(index, 1);
      }
      return Promise.resolve();
    },
    discardSession: (sessionId: string) => {
      if (storeOptions?.discardError) {
        return Promise.reject(storeOptions.discardError);
      }
      for (let index = stored.length - 1; index >= 0; index -= 1) {
        if (stored[index]?.sessionId === sessionId) {
          stored.splice(index, 1);
        }
      }
      const sessionIndex = sessions.findIndex(
        (item) => item.sessionId === sessionId
      );
      if (sessionIndex >= 0) {
        sessions.splice(sessionIndex, 1);
      }
      return Promise.resolve();
    },
    getSession: (sessionId: string) =>
      Promise.resolve(sessions.find((item) => item.sessionId === sessionId)),
    listParts: () => Promise.resolve([...stored]),
    listSessions: () => Promise.resolve([...sessions]),
    put: (value: RecordingPart) => {
      stored.push(value);
      return Promise.resolve();
    },
    putSession: (value: RecordingSession) => {
      const index = sessions.findIndex(
        (item) => item.sessionId === value.sessionId
      );
      if (index >= 0) {
        sessions[index] = value;
      } else {
        sessions.push(value);
      }
      return Promise.resolve();
    },
  };
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit =
      init?.body instanceof Blob
        ? { ...init, body: await init.body.arrayBuffer() }
        : init;
    calls.push(
      new Request(new URL(input.toString(), "http://localhost"), requestInit)
    );
    return new Response(null, { status: 201 });
  };
  return {
    box: createLiveRecordingOutbox(store, request),
    calls,
    deleted,
    sessions,
    stored,
  };
}

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
    discardSession: () => Promise.resolve(),
    put: (value: RecordingPart) => {
      events.push("persist");
      stored.push(value);
      return Promise.resolve();
    },
  };
  const request = async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit =
      init?.body instanceof Blob
        ? { ...init, body: await init.body.arrayBuffer() }
        : init;
    events.push("request");
    calls.push(
      new Request(new URL(input.toString(), "http://localhost"), requestInit)
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

it("persists before PUT and deletes only after a 2xx response", async () => {
  const harnessed = harness();
  await harnessed.box.add(part);
  await harnessed.box.drain();
  expect(harnessed.stored.length).toBe(1);
  expect(harnessed.deleted.length).toBe(1);
  expect(harnessed.events).toEqual(["persist", "request", "delete"]);
  expect(harnessed.box.saveState).toBe("healthy");
  expect(harnessed.calls[0]?.url).toBe(
    "http://localhost/api/recordings/session/segments/segment/parts/3"
  );
});

it("retryable 503 retains the local part and reports retrying", async () => {
  const harnessed = harness(new Response("no", { status: 503 }));
  await harnessed.box.add(part);
  await expect(harnessed.box.drain()).rejects.toThrow(UPLOAD_ERROR);
  expect(harnessed.stored.length).toBe(1);
  expect(harnessed.deleted.length).toBe(0);
  expect(harnessed.box.saveState).toBe("retrying");
  harnessed.box.dispose();
});

it("network failures are classified retryable and report retrying", async () => {
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      put: () => Promise.resolve(),
    },
    () => {
      throw new Error("network unavailable");
    },
    (error) => errors.push(error)
  );
  await box.add(part);
  await expect(box.drain()).rejects.toThrow(NETWORK_OR_PENDING_ERROR);
  expect(isRetryableRecordingFailure(errors[0])).toBe(true);
  expect(box.saveState).toBe("retrying");
  box.dispose();
});

it("uses exact blob checksum and upload headers", async () => {
  const harnessed = harness();
  await harnessed.box.add(part);
  await harnessed.box.drain();
  const [request] = harnessed.calls;
  expect(request).toBeTruthy();
  expect(request.method).toBe("PUT");
  expect(request.headers.get("Content-Type")).toBe("video/webm");
  expect(request.headers.get("X-Content-SHA256")).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
  expect(await request.text()).toBe("hello");
});

function createDeferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
}

function sequencedPart(
  sequence: number,
  overrides: Partial<RecordingPart> = {}
) {
  return { ...part, sequence, ...overrides };
}

function controlledHarness() {
  const stored: RecordingPart[] = [];
  const deleted: RecordingPart[] = [];
  const calls: Request[] = [];
  const sessions: RecordingSession[] = [];
  const respond = vi.fn((_input: RequestInfo | URL, _init?: RequestInit) =>
    Promise.resolve(new Response(null, { status: 204 }))
  );
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit =
      init?.body instanceof Blob
        ? { ...init, body: await init.body.arrayBuffer() }
        : init;
    calls.push(
      new Request(new URL(input.toString(), "http://localhost"), requestInit)
    );
    return await respond(input, init);
  });
  const store = {
    delete: (value: RecordingPart) => {
      deleted.push(value);
      const index = stored.findIndex(
        (item) =>
          item.segmentId === value.segmentId &&
          item.sequence === value.sequence &&
          item.sessionId === value.sessionId
      );
      if (index >= 0) {
        stored.splice(index, 1);
      }
      return Promise.resolve();
    },
    discardSession: () => Promise.resolve(),
    getSession: (sessionId: string) =>
      Promise.resolve(sessions.find((item) => item.sessionId === sessionId)),
    listParts: () => Promise.resolve([...stored]),
    listSessions: () => Promise.resolve([...sessions]),
    put: (value: RecordingPart) => {
      stored.push(value);
      return Promise.resolve();
    },
    putSession: (value: RecordingSession) => {
      const index = sessions.findIndex(
        (item) => item.sessionId === value.sessionId
      );
      if (index >= 0) {
        sessions[index] = value;
      } else {
        sessions.push(value);
      }
      return Promise.resolve();
    },
  };
  return {
    box: createLiveRecordingOutbox(store, fetch),
    calls,
    deleted,
    fetch,
    respond,
    sessions,
    stored,
  };
}

it("drains one ordered request at a time after durable add", async () => {
  const harnessed = controlledHarness();
  const firstResponse = createDeferred<Response>();
  harnessed.respond.mockImplementationOnce(() => firstResponse.promise);

  await Promise.all([
    harnessed.box.add(sequencedPart(0)),
    harnessed.box.add(sequencedPart(1)),
    harnessed.box.add(sequencedPart(2)),
  ]);

  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(1));
  expect(harnessed.calls[0]?.url).toContain("/parts/0");

  firstResponse.resolve(new Response(null, { status: 204 }));
  await harnessed.box.drain();
  expect(harnessed.calls.map((request) => request.url)).toEqual([
    "http://localhost/api/recordings/session/segments/segment/parts/0",
    "http://localhost/api/recordings/session/segments/segment/parts/1",
    "http://localhost/api/recordings/session/segments/segment/parts/2",
  ]);
  harnessed.box.dispose();
});

it("recovers out-of-order parts in session segment order then sequence", async () => {
  const firstResponse = createDeferred<Response>();
  const storedParts = [
    sequencedPart(1, { segmentId: "later" }),
    sequencedPart(1, { segmentId: "earlier" }),
    sequencedPart(0, { segmentId: "later" }),
    sequencedPart(0, { segmentId: "earlier" }),
  ];
  const session: RecordingSession = {
    ...recordingSession,
    segments: [
      { partCount: 2, segmentId: "earlier" },
      { partCount: 2, segmentId: "later" },
    ],
  };
  const calls: Request[] = [];
  const fetch = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const requestInit =
      init?.body instanceof Blob
        ? { ...init, body: await init.body.arrayBuffer() }
        : init;
    calls.push(
      new Request(new URL(input.toString(), "http://localhost"), requestInit)
    );
    if (calls.length === 1) {
      return firstResponse.promise;
    }
    return new Response(null, { status: 204 });
  });
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      getSession: () => Promise.resolve(session),
      listParts: () => Promise.resolve(storedParts),
      listSessions: () => Promise.resolve([session]),
      put: () => Promise.resolve(),
      putSession: () => Promise.resolve(),
    },
    fetch
  );
  await box.hydrate();
  const flushing = box.recoverAndFlush();
  await vi.waitFor(() => expect(calls).toHaveLength(1));
  expect(calls[0]?.url).toContain("/segments/earlier/parts/0");
  firstResponse.resolve(new Response(null, { status: 204 }));
  await flushing;
  expect(calls.map((request) => request.url)).toEqual([
    "http://localhost/api/recordings/session/segments/earlier/parts/0",
    "http://localhost/api/recordings/session/segments/earlier/parts/1",
    "http://localhost/api/recordings/session/segments/later/parts/0",
    "http://localhost/api/recordings/session/segments/later/parts/1",
  ]);
  box.dispose();
});

afterEach(() => {
  vi.useRealTimers();
});

async function flushMicrotasks() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
}

async function waitForCalls(calls: Request[], count: number, timeoutMs = 1000) {
  const started = Date.now();
  while (calls.length < count && Date.now() - started < timeoutMs) {
    // biome-ignore lint/performance/noAwaitInLoops: poll native digest completion without fake timers.
    await new Promise<void>((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = () => resolve();
      channel.port2.postMessage(null);
    });
  }
  expect(calls).toHaveLength(count);
}

it("retries with exponential backoff capped at 30 seconds", async () => {
  const harnessed = controlledHarness();
  const firstResponse = createDeferred<Response>();
  harnessed.respond.mockImplementationOnce(() => firstResponse.promise);
  harnessed.respond.mockResolvedValue(new Response(null, { status: 503 }));
  await harnessed.box.add(sequencedPart(0));
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(1));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  firstResponse.resolve(new Response(null, { status: 503 }));
  await flushMicrotasks();
  const delays = [1000, 2000, 4000, 8000, 16_000, 30_000, 30_000];
  for (const [index, delay] of delays.entries()) {
    // biome-ignore lint/performance/noAwaitInLoops: each backoff step must be observed before the next delay.
    await vi.advanceTimersByTimeAsync(delay - 1);
    await flushMicrotasks();
    expect(harnessed.calls).toHaveLength(index + 1);
    await vi.advanceTimersByTimeAsync(1);
    await waitForCalls(harnessed.calls, index + 2);
  }
  harnessed.box.dispose();
  vi.useRealTimers();
});

it("uses a shorter valid Retry-After hint instead of the computed delay", async () => {
  const harnessed = controlledHarness();
  const firstResponse = createDeferred<Response>();
  harnessed.respond.mockImplementationOnce(() => firstResponse.promise);
  harnessed.respond.mockResolvedValueOnce(new Response(null, { status: 204 }));
  await harnessed.box.add(sequencedPart(0));
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(1));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  firstResponse.resolve(
    new Response(null, { headers: { "Retry-After": "1" }, status: 503 })
  );
  await flushMicrotasks();
  await vi.advanceTimersByTimeAsync(999);
  await flushMicrotasks();
  expect(harnessed.calls).toHaveLength(1);
  await vi.advanceTimersByTimeAsync(1);
  vi.useRealTimers();
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(2));
  harnessed.box.dispose();
});

it("resets the next retry delay after an acknowledgement", async () => {
  const harnessed = controlledHarness();
  const firstResponse = createDeferred<Response>();
  const thirdResponse = createDeferred<Response>();
  harnessed.respond
    .mockImplementationOnce(() => firstResponse.promise)
    .mockResolvedValueOnce(new Response(null, { status: 204 }))
    .mockImplementationOnce(() => thirdResponse.promise)
    .mockResolvedValueOnce(new Response(null, { status: 204 }));
  await harnessed.box.add(sequencedPart(0));
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(1));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  firstResponse.resolve(new Response(null, { status: 503 }));
  await flushMicrotasks();
  expect(harnessed.box.snapshot.deliveryPhase).toBe("retrying");
  await vi.advanceTimersByTimeAsync(1000);
  vi.useRealTimers();
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(2));
  await harnessed.box.add(sequencedPart(1));
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(3));
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  thirdResponse.resolve(new Response(null, { status: 503 }));
  await flushMicrotasks();
  expect(harnessed.box.snapshot.deliveryPhase).toBe("retrying");
  await vi.advanceTimersByTimeAsync(999);
  await flushMicrotasks();
  expect(harnessed.calls).toHaveLength(3);
  await vi.advanceTimersByTimeAsync(1);
  vi.useRealTimers();
  await vi.waitFor(() => expect(harnessed.calls).toHaveLength(4));
  harnessed.box.dispose();
});

it("reconciles the remote manifest before the first resumed upload", async () => {
  const events: string[] = [];
  const sessions = [recordingSession];
  const stored = [sequencedPart(0)];
  const manifestReady = createDeferred<void>();
  const fetch = vi.fn(() => {
    events.push("upload");
    return Promise.resolve(new Response(null, { status: 204 }));
  });
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      getSession: () => Promise.resolve(recordingSession),
      listParts: () => Promise.resolve([...stored]),
      listSessions: () => Promise.resolve([...sessions]),
      put: () => Promise.resolve(),
      putSession: async () => {
        events.push("reconcile");
        await manifestReady.promise;
      },
    },
    fetch
  );
  await box.hydrate();
  await box.setOnline(true, { flush: false });
  const recovering = box.recoverAndFlush({
    kind: "found",
    manifest: manifestParts([
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]),
  });
  await vi.waitFor(() =>
    expect(box.snapshot.deliveryPhase).toBe("reconnecting")
  );
  await vi.waitFor(() => expect(events).toEqual(["reconcile"]));
  manifestReady.resolve();
  await recovering;
  expect(events[0]).toBe("reconcile");
  expect(events.includes("upload")).toBe(true);
  box.dispose();
});

it("counts recovered bytes and decreases them only after local delete", async () => {
  const deleted: RecordingPart[] = [];
  const releaseDelete = createDeferred<void>();
  const partZero = sequencedPart(0, { blob: new Blob(["abcd"]) });
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  const box = createLiveRecordingOutbox(
    {
      delete: async (value) => {
        await releaseDelete.promise;
        deleted.push(value);
      },
      discardSession: () => Promise.resolve(),
      getSession: () => Promise.resolve(recordingSession),
      listParts: () => Promise.resolve([partZero]),
      listSessions: () => Promise.resolve([recordingSession]),
      put: () => Promise.resolve(),
      putSession: () => Promise.resolve(),
    },
    fetch
  );
  await box.hydrate();
  expect(box.snapshot.pendingBytes).toBe(4);
  const flushing = box.recoverAndFlush();
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(1));
  expect(box.snapshot.pendingBytes).toBe(4);
  expect(deleted).toHaveLength(0);
  releaseDelete.resolve();
  await flushing;
  expect(box.snapshot.pendingBytes).toBe(0);
  expect(deleted).toHaveLength(1);
  box.dispose();
});

it("retains local bytes after a non-retryable 409", async () => {
  const harnessed = controlledHarness();
  harnessed.respond.mockResolvedValue(new Response(null, { status: 409 }));
  await harnessed.box.add(sequencedPart(0, { blob: new Blob(["hello"]) }));
  await expect(harnessed.box.drain()).rejects.toThrow(UPLOAD_ERROR);
  expect(harnessed.deleted).toHaveLength(0);
  expect(harnessed.box.snapshot.pendingBytes).toBe(5);
  expect(harnessed.box.snapshot.pendingPartCount).toBe(1);
  harnessed.box.dispose();
});

it("does not upload later parts after a terminal predecessor", async () => {
  const harnessed = controlledHarness();
  harnessed.respond
    .mockResolvedValueOnce(new Response(null, { status: 409 }))
    .mockResolvedValue(new Response(null, { status: 201 }));
  await harnessed.box.add(sequencedPart(0, { blob: new Blob(["first"]) }));
  await expect(harnessed.box.drain()).rejects.toThrow(UPLOAD_ERROR);
  await harnessed.box.add(sequencedPart(1, { blob: new Blob(["second"]) }));
  await expect(harnessed.box.drain()).rejects.toThrow(UPLOAD_ERROR);
  expect(harnessed.calls).toHaveLength(1);
  expect(harnessed.calls[0]?.url).toContain("/parts/0");
  expect(harnessed.deleted).toHaveLength(0);
  expect(harnessed.box.snapshot.pendingPartCount).toBe(2);
  harnessed.box.dispose();
});

it("keeps an ambiguous rejected fetch first in drain order", async () => {
  const harnessed = controlledHarness();
  harnessed.respond
    .mockRejectedValueOnce(new Error("network down"))
    .mockResolvedValue(new Response(null, { status: 204 }));
  await harnessed.box.add(sequencedPart(0));
  await harnessed.box.add(sequencedPart(1));
  await expect(harnessed.box.drain()).rejects.toThrow(AMBIGUOUS_UPLOAD_ERROR);
  expect(harnessed.calls).toHaveLength(1);
  expect(harnessed.calls[0]?.url).toContain("/parts/0");
  expect(harnessed.deleted).toHaveLength(0);
  expect(harnessed.box.snapshot.pendingPartCount).toBe(2);
  harnessed.box.dispose();
});

it("a successful part does not clear retrying for another failed part", async () => {
  const requests: Request[] = [];
  const deleted: RecordingPart[] = [];
  const stored: RecordingPart[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: (value) => {
        deleted.push(value);
        return Promise.resolve();
      },
      discardSession: () => Promise.resolve(),
      put: (value) => {
        stored.push(value);
        return Promise.resolve();
      },
    },
    async (input, init) => {
      const requestInit =
        init?.body instanceof Blob
          ? { ...init, body: await init.body.arrayBuffer() }
          : init;
      const request = new Request(
        new URL(input.toString(), "http://localhost"),
        requestInit
      );
      requests.push(request);
      await Promise.resolve();
      return new Response(null, {
        status: request.url.endsWith("/1") ? 503 : 201,
      });
    }
  );
  await box.add({ ...part, sequence: 1 });
  await expect(box.drain()).rejects.toThrow(UPLOAD_ERROR);
  expect(requests.length).toBe(1);
  await box.add({ ...part, sequence: 2 });
  expect(stored.length).toBe(2);
  expect(deleted.length).toBe(0);
  expect(box.saveState).toBe("retrying");
  box.dispose();
});

it("dispose prevents retry after an in-flight retryable failure", async () => {
  let rejectRequest!: (error: Error) => void;
  let resolveStarted!: () => void;
  let requests = 0;
  const started = new Promise<void>((resolve) => {
    resolveStarted = resolve;
  });
  const store = {
    delete: () => Promise.resolve(),
    discardSession: () => Promise.resolve(),
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
  expect(requests).toBe(1);
  expect(box.pendingCount).toBe(1);
});

it("persistence failures reject and never request", async () => {
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      put: () => {
        throw new Error("storage unavailable");
      },
    },
    fetch,
    (error) => errors.push(error)
  );
  await expect(box.add(part)).rejects.toThrow(STORAGE_ERROR);
  expect((errors[0] as Error).message).toBe("storage unavailable");
  expect(isRetryableRecordingFailure(errors[0])).toBe(false);
  expect(box.saveState).toBe("error");
});

it("terminal upload failure is retained and does not retry when online", async () => {
  let requests = 0;
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      put: () => Promise.resolve(),
    },
    async () => {
      requests += 1;
      await Promise.resolve();
      return new Response(null, { status: 409 });
    },
    (error) => errors.push(error)
  );
  await box.add(part);
  await expect(box.drain()).rejects.toThrow(UPLOAD_ERROR);
  await box.setOnline(false);
  await box.setOnline(true);
  expect(requests).toBe(1);
  expect(box.pendingCount).toBe(1);
  expect(box.saveState).toBe("error");
  expect(errors.length).toBe(1);
  box.dispose();
});

it("drain does not resolve while offline work is pending", async () => {
  const h = harness();
  await h.box.setOnline(false);
  await h.box.add(part);
  await expect(h.box.drain()).rejects.toThrow(PENDING_ERROR);
  await h.box.setOnline(true);
  await h.box.drain();
  expect(h.box.pendingCount).toBe(0);
});

it("drain rejects terminal failures", async () => {
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      put: () => Promise.resolve(),
    },
    async () => new Response(null, { status: 409 })
  );
  await box.add(part);
  await expect(box.drain()).rejects.toThrow(UPLOAD_ERROR);
  box.dispose();
});

it("reuses zero-tail intent metadata for remote retry", () => {
  const session: RecordingSession = {
    recorderMimeType: "video/webm;codecs=vp8,opus",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 0, segmentId: "tail" }],
    sessionId: "session",
    status: "recording",
  };
  expect(
    recordingIntentMetadata(session, {
      recorderMimeType: "video/mp4",
      requestedMimeType: "video/mp4",
    })
  ).toEqual({
    recorderMimeType: session.recorderMimeType,
    requestedMimeType: session.requestedMimeType,
  });
});

it("selects create for an initial tail and append for later tails", () => {
  const initial: RecordingSession = {
    recorderMimeType: null,
    requestedMimeType: null,
    segments: [{ partCount: 0, segmentId: "initial" }],
    sessionId: "session",
    status: "recording",
  };
  const later = {
    ...initial,
    segments: [...initial.segments, { partCount: 0, segmentId: "later" }],
  };
  expect(recordingRemoteAction(initial, true)).toBe("create");
  expect(recordingRemoteAction(later, true)).toBe("append");
  expect(recordingRemoteAction(undefined, false)).toBe("create");
  expect(recordingRemoteAction(later, false)).toBe("append");
});

it("allows retrying an empty fifth tail but not adding a sixth", () => {
  const fifth: RecordingSession = {
    recorderMimeType: null,
    requestedMimeType: null,
    segments: Array.from({ length: 5 }, (_, index) => ({
      partCount: index === 4 ? 0 : 1,
      segmentId: `segment-${index}`,
    })),
    sessionId: "session",
    status: "recording",
  };
  expect(fifth.segments.at(-1)?.partCount).toBe(0);
  expect(recordingRemoteAction(fifth, true)).toBe("append");
  expect(fifth.segments.length).toBe(5);
});

it("keeps orphan parts without fabricating session metadata", async () => {
  const sessions: RecordingSession[] = [];
  const parts = [
    { ...part, segmentId: "a1", sequence: 0, sessionId: "a" },
    { ...part, segmentId: "a2", sequence: 4, sessionId: "a" },
    { ...part, segmentId: "b1", sequence: 2, sessionId: "b" },
  ];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      listParts: () => Promise.resolve(parts),
      listSessions: () => Promise.resolve(sessions),
      put: () => Promise.resolve(),
      putSession: (value) => {
        sessions.push(value);
        return Promise.resolve();
      },
    },
    async () => new Response(null, { status: 503 })
  );
  await box.hydrate();
  expect(sessions).toEqual([]);
  expect(box.pendingCount).toBe(3);
  box.dispose();
});

it("savePartAndSession reports durable persistence failure", async () => {
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      discardSession: () => Promise.resolve(),
      put: () => Promise.resolve(),
      putPartAndSession: () => Promise.reject(new Error("storage unavailable")),
    },
    fetch,
    (error) => errors.push(error)
  );
  await expect(
    box.savePartAndSession(part, {
      recorderMimeType: "video/webm",
      requestedMimeType: "video/webm",
      segments: [{ partCount: 4, segmentId: part.segmentId }],
      sessionId: part.sessionId,
      status: "recording",
    })
  ).rejects.toThrow(STORAGE_ERROR);
  expect(box.saveState).toBe("error");
  expect(errors.length).toBe(1);
});

it("reconcile drops matching acknowledgements and keeps missing parts", async () => {
  const acked = { ...part, sequence: 1 };
  const missing = { ...part, sequence: 3 };
  const result = await reconcileRecordingParts({
    localParts: [acked, missing],
    localSession: recordingSession,
    manifest: manifestParts([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
    ]),
  });
  expect(result.drop.map((item) => item.sequence)).toEqual([1]);
  expect(result.keep.map((item) => item.sequence)).toEqual([3]);
  expect(result.integrity).toBe("ok");
  expect(result.session?.segments[0]?.partCount).toBe(4);
});

it("reload recovers acknowledged parts without duplicating uploads", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover({
    kind: "found",
    manifest: manifestParts([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
    ]),
  });
  expect(recovery.recovered).toBe(true);
  expect(recovery.integrity).toBe("ok");
  expect(harnessed.calls.length).toBe(1);
  expect(harnessed.calls[0]?.url.endsWith("/parts/3")).toBe(true);
  expect(harnessed.deleted.length).toBe(1);
  expect(harnessed.box.pendingCount).toBe(0);
  harnessed.box.dispose();
});

it("retains the local session when recover runs without a remote lookup", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover();
  expect(recovery.recovered).toBe(true);
  expect(recovery.missing).toBe(false);
  expect(harnessed.sessions).toHaveLength(1);
  harnessed.box.dispose();
});

it("marks a typed missing recording without deleting it", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover({
    kind: "missing",
  });
  expect(recovery.missing).toBe(true);
  expect(harnessed.sessions).toHaveLength(1);
  expect(harnessed.stored).toHaveLength(1);
  harnessed.box.dispose();
});

it("preserves durable and in-memory state when discard fails", async () => {
  const harnessed = recoveryHarness(
    [{ ...part, sequence: 3 }],
    recordingSession,
    {
      discardError: new Error("storage unavailable"),
    }
  );
  await harnessed.box.hydrate();
  await expect(harnessed.box.discardSession("session")).rejects.toThrow(
    "storage unavailable"
  );
  expect(harnessed.sessions).toHaveLength(1);
  expect(harnessed.stored).toHaveLength(1);
  expect(harnessed.box.pendingCount).toBe(1);
});

it("lost acknowledgement drops a matching local copy without discarding bytes", async () => {
  const local = { ...part, sequence: 3 };
  const harnessed = recoveryHarness([local]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover({
    kind: "found",
    manifest: manifestParts([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]),
  });
  expect(recovery.integrity).toBe("ok");
  expect(harnessed.calls.length).toBe(0);
  expect(harnessed.deleted.length).toBe(1);
  expect(harnessed.stored.length).toBe(0);
  harnessed.box.dispose();
});

it("reconcile continues when dropping an acknowledged part fails in storage", async () => {
  const local = { ...part, sequence: 3 };
  const harnessed = recoveryHarness([local], recordingSession, {
    deleteError: new Error("IndexedDB delete failed"),
  });
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover({
    kind: "found",
    manifest: manifestParts([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
      { sequence: 3 },
    ]),
  });
  expect(recovery.recovered).toBe(true);
  expect(recovery.integrity).toBe("ok");
  expect(harnessed.box.pendingCount).toBe(0);
  expect(harnessed.stored.length).toBe(1);
  harnessed.box.dispose();
});

it("offline hydrate retains parts and reconciles after reconnect", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.setOnline(false);
  await harnessed.box.hydrate();
  const offline = await harnessed.box.recover();
  expect(offline.recovered).toBe(true);
  expect(harnessed.calls.length).toBe(0);
  expect(harnessed.box.pendingCount).toBe(1);
  await harnessed.box.setOnline(true, { flush: false });
  await harnessed.box.recover({
    kind: "found",
    manifest: manifestParts([
      { sequence: 0 },
      { sequence: 1 },
      { sequence: 2 },
    ]),
  });
  expect(harnessed.calls.length).toBe(1);
  expect(harnessed.box.pendingCount).toBe(0);
  harnessed.box.dispose();
});

it("conflicting checksums retain local media and refuse finalization", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 2 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover({
    kind: "found",
    manifest: manifestParts([
      { sequence: 0 },
      { sequence: 1 },
      { checksum: OTHER_CHECKSUM, sequence: 2 },
    ]),
  });
  expect(recovery.integrity).toBe("conflict");
  expect(harnessed.deleted.length).toBe(0);
  expect(harnessed.stored.length).toBe(1);
  expect(harnessed.box.pendingCount).toBe(1);
  expect(harnessed.box.saveState).toBe("error");
  expect(integrityMessage("conflict")?.includes("conflicting")).toBe(true);
  await expect(harnessed.box.drain()).rejects.toThrow(PENDING_ERROR);
  expect(() => harnessed.box.assertCanFinalize()).toThrow(
    CONFLICT_FINALIZE_ERROR
  );
  harnessed.box.dispose();
});

it("missing ordered parts refuse misleading finalization", async () => {
  const harnessed = recoveryHarness([], {
    ...recordingSession,
    segments: [{ partCount: 3, segmentId: "segment" }],
  });
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover({
    kind: "found",
    manifest: manifestParts([{ sequence: 0 }, { sequence: 1 }]),
  });
  expect(recovery.integrity).toBe("gap");
  expect(harnessed.calls.length).toBe(0);
  await harnessed.box.drain();
  expect(() => harnessed.box.assertCanFinalize()).toThrow(GAP_FINALIZE_ERROR);
  harnessed.box.dispose();
});

it("selects append after recovering a non-empty tail", () => {
  const recovered: RecordingSession = {
    recorderMimeType: "video/webm",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 3, segmentId: "interrupted" }],
    sessionId: "session",
    status: "recording",
  };
  const resumeTail = recovered.segments.at(-1)?.partCount === 0;
  expect(resumeTail).toBe(false);
  expect(recordingRemoteAction(recovered, resumeTail)).toBe("append");
});
