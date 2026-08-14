import { expect, it } from "vitest";
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
  expect(isRetryableRecordingFailure(errors[0])).toBe(true);
  expect(box.saveState).toBe("retrying");
  box.dispose();
});

it("uses exact blob checksum and upload headers", async () => {
  const harnessed = harness();
  await harnessed.box.add(part);
  const [request] = harnessed.calls;
  expect(request).toBeTruthy();
  expect(request.method).toBe("PUT");
  expect(request.headers.get("Content-Type")).toBe("video/webm");
  expect(request.headers.get("X-Content-SHA256")).toBe(
    "2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824"
  );
  expect(await request.text()).toBe("hello");
});

it("several parts can be persisted and uploaded while active", async () => {
  const harnessed = harness();
  await Promise.all(
    [1, 2, 3].map((sequence) => harnessed.box.add({ ...part, sequence }))
  );
  expect(harnessed.stored.length).toBe(3);
  expect(harnessed.deleted.length).toBe(3);
  expect(harnessed.calls.length).toBe(3);
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
  await box.setOnline(false);
  await box.add({ ...part, sequence: 1 });
  await box.add({ ...part, sequence: 2 });
  await box.setOnline(true);
  expect(requests.length).toBe(2);
  expect(stored.length).toBe(2);
  expect(deleted.length).toBe(1);
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
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve({
      kind: "found",
      manifest: manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { sequence: 2 },
      ]),
    })
  );
  expect(recovery.recovered).toBe(true);
  expect(recovery.integrity).toBe("ok");
  expect(harnessed.calls.length).toBe(1);
  expect(harnessed.calls[0]?.url.endsWith("/parts/3")).toBe(true);
  expect(harnessed.deleted.length).toBe(1);
  expect(harnessed.box.pendingCount).toBe(0);
  harnessed.box.dispose();
});

it("retains local recovery when manifest lookup fails", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.hydrate();
  await expect(
    harnessed.box.recover(() => {
      throw new Error("deployment unavailable");
    })
  ).rejects.toThrow("deployment unavailable");
  expect(harnessed.sessions).toHaveLength(1);
  expect(harnessed.stored).toHaveLength(1);
  harnessed.box.dispose();
});

it("marks a typed missing recording without deleting it", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover(async () => ({
    kind: "missing",
  }));
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
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve({
      kind: "found",
      manifest: manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { sequence: 2 },
        { sequence: 3 },
      ]),
    })
  );
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
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve({
      kind: "found",
      manifest: manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { sequence: 2 },
        { sequence: 3 },
      ]),
    })
  );
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
  const offline = await harnessed.box.recover(() => {
    throw new Error("manifest should not be fetched offline");
  });
  expect(offline.recovered).toBe(true);
  expect(harnessed.calls.length).toBe(0);
  expect(harnessed.box.pendingCount).toBe(1);
  await harnessed.box.setOnline(true, { flush: false });
  await harnessed.box.recover(() =>
    Promise.resolve({
      kind: "found",
      manifest: manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { sequence: 2 },
      ]),
    })
  );
  expect(harnessed.calls.length).toBe(1);
  expect(harnessed.box.pendingCount).toBe(0);
  harnessed.box.dispose();
});

it("conflicting checksums retain local media and refuse finalization", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 2 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve({
      kind: "found",
      manifest: manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { checksum: OTHER_CHECKSUM, sequence: 2 },
      ]),
    })
  );
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
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve({
      kind: "found",
      manifest: manifestParts([{ sequence: 0 }, { sequence: 1 }]),
    })
  );
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
