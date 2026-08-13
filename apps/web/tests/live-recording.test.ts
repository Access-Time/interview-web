import assert from "node:assert/strict";
import test from "node:test";
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
const DRAIN_OR_CONFLICT_ERROR = /conflicting|pending|upload/i;
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

function recoveryHarness(parts: RecordingPart[], session = recordingSession) {
  const stored = [...parts];
  const sessions = [session];
  const deleted: RecordingPart[] = [];
  const calls: Request[] = [];
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
  const request = (input: RequestInfo | URL, init?: RequestInit) => {
    calls.push(
      new Request(new URL(input.toString(), "http://localhost"), init)
    );
    return Promise.resolve(new Response(null, { status: 201 }));
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

test("drain does not resolve while offline work is pending", async () => {
  const h = harness();
  await h.box.setOnline(false);
  await h.box.add(part);
  await assert.rejects(h.box.drain(), PENDING_ERROR);
  await h.box.setOnline(true);
  await h.box.drain();
  assert.equal(h.box.pendingCount, 0);
});

test("drain rejects terminal failures", async () => {
  const box = createLiveRecordingOutbox(
    { delete: () => Promise.resolve(), put: () => Promise.resolve() },
    async () => new Response(null, { status: 409 })
  );
  await box.add(part);
  await assert.rejects(box.drain(), UPLOAD_ERROR);
  box.dispose();
});

test("reuses zero-tail intent metadata for remote retry", () => {
  const session: RecordingSession = {
    recorderMimeType: "video/webm;codecs=vp8,opus",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 0, segmentId: "tail" }],
    sessionId: "session",
    status: "recording",
  };
  assert.deepEqual(
    recordingIntentMetadata(session, {
      recorderMimeType: "video/mp4",
      requestedMimeType: "video/mp4",
    }),
    {
      recorderMimeType: session.recorderMimeType,
      requestedMimeType: session.requestedMimeType,
    }
  );
});

test("selects create for an initial tail and append for later tails", () => {
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
  assert.equal(recordingRemoteAction(initial, true), "create");
  assert.equal(recordingRemoteAction(later, true), "append");
  assert.equal(recordingRemoteAction(undefined, false), "create");
  assert.equal(recordingRemoteAction(later, false), "append");
});

test("allows retrying an empty fifth tail but not adding a sixth", () => {
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
  assert.equal(fifth.segments.at(-1)?.partCount, 0);
  assert.equal(recordingRemoteAction(fifth, true), "append");
  assert.equal(fifth.segments.length, 5);
});

test("keeps orphan parts without fabricating session metadata", async () => {
  const sessions: RecordingSession[] = [];
  const parts = [
    { ...part, segmentId: "a1", sequence: 0, sessionId: "a" },
    { ...part, segmentId: "a2", sequence: 4, sessionId: "a" },
    { ...part, segmentId: "b1", sequence: 2, sessionId: "b" },
  ];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
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
  assert.deepEqual(sessions, []);
  assert.equal(box.pendingCount, 3);
  box.dispose();
});

test("savePartAndSession reports durable persistence failure", async () => {
  const errors: unknown[] = [];
  const box = createLiveRecordingOutbox(
    {
      delete: () => Promise.resolve(),
      put: () => Promise.resolve(),
      putPartAndSession: () => Promise.reject(new Error("storage unavailable")),
    },
    fetch,
    (error) => errors.push(error)
  );
  await assert.rejects(
    box.savePartAndSession(part, {
      recorderMimeType: "video/webm",
      requestedMimeType: "video/webm",
      segments: [{ partCount: 4, segmentId: part.segmentId }],
      sessionId: part.sessionId,
      status: "recording",
    }),
    STORAGE_ERROR
  );
  assert.equal(box.saveState, "error");
  assert.equal(errors.length, 1);
});

test("reconcile drops matching acknowledgements and keeps missing parts", async () => {
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
  assert.deepEqual(
    result.drop.map((item) => item.sequence),
    [1]
  );
  assert.deepEqual(
    result.keep.map((item) => item.sequence),
    [3]
  );
  assert.equal(result.integrity, "ok");
  assert.equal(result.session?.segments[0]?.partCount, 4);
});

test("reload recovers acknowledged parts without duplicating uploads", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve(
      manifestParts([{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }])
    )
  );
  assert.equal(recovery.recovered, true);
  assert.equal(recovery.integrity, "ok");
  assert.equal(harnessed.calls.length, 1);
  assert.equal(harnessed.calls[0]?.url.endsWith("/parts/3"), true);
  assert.equal(harnessed.deleted.length, 1);
  assert.equal(harnessed.box.pendingCount, 0);
  harnessed.box.dispose();
});

test("lost acknowledgement drops a matching local copy without discarding bytes", async () => {
  const local = { ...part, sequence: 3 };
  const harnessed = recoveryHarness([local]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve(
      manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { sequence: 2 },
        { sequence: 3 },
      ])
    )
  );
  assert.equal(recovery.integrity, "ok");
  assert.equal(harnessed.calls.length, 0);
  assert.equal(harnessed.deleted.length, 1);
  assert.equal(harnessed.stored.length, 0);
  assert.equal(harnessed.box.pendingCount, 0);
  harnessed.box.dispose();
});

test("offline hydrate retains parts and reconciles after reconnect", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 3 }]);
  await harnessed.box.setOnline(false);
  await harnessed.box.hydrate();
  const offline = await harnessed.box.recover(() => {
    throw new Error("manifest should not be fetched offline");
  });
  assert.equal(offline.recovered, true);
  assert.equal(harnessed.calls.length, 0);
  assert.equal(harnessed.box.pendingCount, 1);
  await harnessed.box.setOnline(true, { flush: false });
  await harnessed.box.recover(() =>
    Promise.resolve(
      manifestParts([{ sequence: 0 }, { sequence: 1 }, { sequence: 2 }])
    )
  );
  assert.equal(harnessed.calls.length, 1);
  assert.equal(harnessed.box.pendingCount, 0);
  harnessed.box.dispose();
});

test("conflicting checksums retain local media and refuse finalization", async () => {
  const harnessed = recoveryHarness([{ ...part, sequence: 2 }]);
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve(
      manifestParts([
        { sequence: 0 },
        { sequence: 1 },
        { checksum: OTHER_CHECKSUM, sequence: 2 },
      ])
    )
  );
  assert.equal(recovery.integrity, "conflict");
  assert.equal(harnessed.deleted.length, 0);
  assert.equal(harnessed.stored.length, 1);
  assert.equal(harnessed.box.pendingCount, 1);
  assert.equal(harnessed.box.saveState, "error");
  assert.equal(integrityMessage("conflict")?.includes("conflicting"), true);
  await assert.rejects(harnessed.box.drain(), DRAIN_OR_CONFLICT_ERROR);
  assert.throws(
    () => harnessed.box.assertCanFinalize(),
    CONFLICT_FINALIZE_ERROR
  );
  harnessed.box.dispose();
});

test("missing ordered parts refuse misleading finalization", async () => {
  const harnessed = recoveryHarness([], {
    ...recordingSession,
    segments: [{ partCount: 3, segmentId: "segment" }],
  });
  await harnessed.box.hydrate();
  const recovery = await harnessed.box.recover(() =>
    Promise.resolve(manifestParts([{ sequence: 0 }, { sequence: 1 }]))
  );
  assert.equal(recovery.integrity, "gap");
  assert.equal(harnessed.calls.length, 0);
  await harnessed.box.drain();
  assert.throws(() => harnessed.box.assertCanFinalize(), GAP_FINALIZE_ERROR);
  harnessed.box.dispose();
});

test("selects append after recovering a non-empty tail", () => {
  const recovered: RecordingSession = {
    recorderMimeType: "video/webm",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 3, segmentId: "interrupted" }],
    sessionId: "session",
    status: "recording",
  };
  const resumeTail = recovered.segments.at(-1)?.partCount === 0;
  assert.equal(resumeTail, false);
  assert.equal(recordingRemoteAction(recovered, resumeTail), "append");
});
