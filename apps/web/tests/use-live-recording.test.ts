import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  getRecordingStoragePolicy,
  type RecordingManifestLookup,
  type UseLiveRecordingResult,
  useLiveRecording,
} from "../src/recording/live-recording.ts";

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
const NodeEvent = Event;
const globalProperties = [
  "Event",
  "navigator",
  "indexedDB",
  "MediaRecorder",
  "fetch",
];

function installIndexedDb(options?: {
  probeFails?: boolean;
  writeFailsAfterPart?: number;
}) {
  const records = {
    parts: new Map<string, unknown>(),
    sessions: new Map<string, unknown>(),
  };
  const storeNames = new Set<string>();
  let successfulPartWrites = 0;

  const requestFor = <T>(result: T) => {
    const request = {
      error: null,
      onerror: null as ((event: Event) => void) | null,
      onsuccess: null as ((event: Event) => void) | null,
      result,
    };
    queueMicrotask(() => request.onsuccess?.(new NodeEvent("success")));
    return request;
  };

  const database = {
    createObjectStore(name: string) {
      storeNames.add(name);
      return {} as IDBObjectStore;
    },
    objectStoreNames: {
      contains(name: string) {
        return storeNames.has(name);
      },
    } as DOMStringList,
    transaction(_names: string | string[], _mode?: IDBTransactionMode) {
      let transaction!: {
        error: DOMException | null;
        objectStore: (name: "parts" | "sessions") => IDBObjectStore;
        onabort: ((event: Event) => void) | null;
        oncomplete: ((event: Event) => void) | null;
        onerror: ((event: Event) => void) | null;
      };
      const complete = () =>
        queueMicrotask(() =>
          transaction.oncomplete?.(new NodeEvent("complete"))
        );
      const objectStore = (name: "parts" | "sessions") => {
        const values = records[name];
        return {
          delete(key: IDBValidKey) {
            values.delete(String(key));
            complete();
            return {} as IDBRequest;
          },
          getAll() {
            return requestFor([...values.values()]) as unknown as IDBRequest;
          },
          put(value: unknown) {
            const record = value as { id?: string; sessionId?: string };
            const key = name === "parts" ? record.id : record.sessionId;
            if (!key) {
              throw new Error(`Missing ${name} key`);
            }
            if (
              name === "parts" &&
              options?.probeFails &&
              key === "__recording_preflight_probe__"
            ) {
              throw new Error("probe failed");
            }
            if (
              name === "parts" &&
              key !== "__recording_preflight_probe__" &&
              options?.writeFailsAfterPart !== undefined &&
              successfulPartWrites >= options.writeFailsAfterPart
            ) {
              throw new Error("IndexedDB write failed");
            }
            if (name === "parts" && key !== "__recording_preflight_probe__") {
              successfulPartWrites += 1;
            }
            values.set(key, value);
            complete();
            return {} as IDBRequest;
          },
        } as unknown as IDBObjectStore;
      };
      transaction = {
        error: null,
        objectStore,
        onabort: null,
        oncomplete: null,
        onerror: null,
      };
      return transaction as unknown as IDBTransaction;
    },
  } as unknown as IDBDatabase;

  const open = () => {
    const request = {
      error: null,
      onerror: null as ((event: Event) => void) | null,
      onsuccess: null as ((event: Event) => void) | null,
      onupgradeneeded: null as ((event: Event) => void) | null,
      result: database,
    };
    queueMicrotask(() => {
      request.onupgradeneeded?.(new NodeEvent("upgradeneeded"));
      queueMicrotask(() => request.onsuccess?.(new NodeEvent("success")));
    });
    return request as unknown as IDBOpenDBRequest;
  };

  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: { open } as unknown as IDBFactory,
  });
  return {
    parts: records.parts,
    sessions: records.sessions,
  };
}

function installStorage(overrides?: {
  estimate?: { quota?: number; usage?: number };
  persist?: boolean;
  persisted?: boolean;
}) {
  const storage = {
    estimate: vi
      .fn()
      .mockResolvedValue(
        overrides?.estimate ?? { quota: 1_000_000_000, usage: 10 }
      ),
    persist: vi.fn().mockResolvedValue(overrides?.persist ?? true),
    persisted: vi.fn().mockResolvedValue(overrides?.persisted ?? true),
  };
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: storage,
  });
  return storage;
}

function installBrowserGlobals(options?: {
  probeFails?: boolean;
  storage?: {
    estimate?: { quota?: number; usage?: number };
    persist?: boolean;
    persisted?: boolean;
  };
  writeFailsAfterPart?: number;
}) {
  for (const property of globalProperties) {
    originalDescriptors.set(
      property,
      Object.getOwnPropertyDescriptor(globalThis, property)
    );
  }
  Object.defineProperty(globalThis.navigator, "onLine", {
    configurable: true,
    value: true,
  });
  installStorage(options?.storage);
  return installIndexedDb({
    probeFails: options?.probeFails,
    writeFailsAfterPart: options?.writeFailsAfterPart,
  });
}

const events: string[] = [];
const tracks = [
  { kind: "audio", stop: () => events.push("audio-track-stopped") },
  { kind: "video", stop: () => events.push("video-track-stopped") },
] as unknown as MediaStreamTrack[];
const stream = { getTracks: () => tracks } as unknown as MediaStream;
let uploadStatus = 201;
let uploadCalls = 0;

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }

  audioBitsPerSecond = 128_000;
  mimeType = "video/webm";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  state: RecordingState = "inactive";
  videoBitsPerSecond = 1_000_000;

  static last: FakeMediaRecorder | null = null;

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    super();
    FakeMediaRecorder.last = this;
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.emitData("captured");
    events.push("capture-ended");
    const stopEvent = new NodeEvent("stop");
    this.dispatchEvent(stopEvent);
    this.onstop?.(stopEvent);
  }

  emitError() {
    this.state = "inactive";
    const errorEvent = new NodeEvent("error");
    this.onerror?.(errorEvent);
    this.onerror?.(errorEvent);
    this.emitData("terminal");
    const stopEvent = new NodeEvent("stop");
    this.dispatchEvent(stopEvent);
    this.onstop?.(stopEvent);
  }

  emitData(value: string) {
    this.ondataavailable?.({
      data: new Blob([value], { type: this.mimeType }),
    } as BlobEvent);
  }
}

let latest: UseLiveRecordingResult | null = null;
let finalizeCalls = 0;
let finalizeMode: "failed" | "queued" | "ready" = "ready";
let resolveFinalization: (() => void) | null = null;
let remoteStatus: "ready" | undefined;
let manifestLookup: (() => Promise<RecordingManifestLookup>) | undefined;

function RecordingHost() {
  latest = useLiveRecording({
    appendSegment: (_input, { onSuccess }) => {
      onSuccess(undefined);
    },
    createSession: (_input, { onSuccess }) => {
      onSuccess(undefined);
    },
    finalizeSession: (_input, { onError, onSuccess }) => {
      finalizeCalls += 1;
      resolveFinalization = () => {
        if (finalizeMode === "failed") {
          onError(new Error("finalization unavailable"));
          return;
        }
        onSuccess({ status: finalizeMode });
      };
    },
    getManifest: manifestLookup
      ? async () => manifestLookup?.() ?? { kind: "missing" }
      : undefined,
    status: remoteStatus,
  });
  return null;
}

afterEach(() => {
  cleanup();
  for (const property of globalProperties) {
    const descriptor = originalDescriptors.get(property);
    if (descriptor) {
      Object.defineProperty(globalThis, property, descriptor);
    } else {
      Reflect.deleteProperty(globalThis, property);
    }
  }
  originalDescriptors.clear();
  events.length = 0;
  latest = null;
  finalizeCalls = 0;
  finalizeMode = "ready";
  resolveFinalization = null;
  remoteStatus = undefined;
  manifestLookup = undefined;
  uploadStatus = 201;
  uploadCalls = 0;
  FakeMediaRecorder.last = null;
});

it("normal stop releases tracks after capture and retains submission", async () => {
  installBrowserGlobals();
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => Promise.resolve(new Response(null, { status: uploadStatus })),
  });

  render(React.createElement(RecordingHost));
  await waitFor(() => expect(latest).not.toBe(null));
  await expect(latest?.resetRecoveredRecording()).rejects.toThrow(
    "cannot be reset"
  );

  await act(async () => {
    await latest?.initialize();
  });
  await waitFor(() => expect(latest?.isReady).toBe(true));

  await act(async () => {
    await latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));

  let stopPromise: Promise<void> | undefined;
  await act(async () => {
    stopPromise = latest?.stop();
    await Promise.resolve();
  });
  await waitFor(() => expect(finalizeCalls).toBe(1));
  expect(latest?.captureEnded).toBe(true);
  expect(latest?.stream).toBe(null);
  expect(latest?.isReady).toBe(false);
  expect(events).toEqual([
    "audio-track-stopped",
    "video-track-stopped",
    "capture-ended",
  ]);
  expect(latest?.stream).toBe(null);
  expect(latest?.isReady).toBe(false);
  await act(async () => {
    resolveFinalization?.();
    await stopPromise;
  });
});

it("releases media and stays terminal after a fatal upload", async () => {
  installBrowserGlobals();
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });
  uploadStatus = 400;
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: () => {
      uploadCalls += 1;
      return Promise.resolve(new Response(null, { status: uploadStatus }));
    },
  });

  render(React.createElement(RecordingHost));
  await act(async () => {
    await latest?.initialize();
  });
  await waitFor(() => expect(latest?.isReady).toBe(true));
  await act(async () => {
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("captured");
  await waitFor(() => expect(uploadCalls).toBeGreaterThan(0));
  await waitFor(() => expect(latest?.saveState).toBe("error"));
  let stopPromise: Promise<void> | undefined;
  await act(async () => {
    stopPromise = latest?.stop();
    await Promise.resolve();
  });
  expect(latest?.captureEnded).toBe(true);
  expect(latest?.isReady).toBe(false);
  expect(latest?.stream).toBe(null);
  expect(
    events.filter((event) => event === "audio-track-stopped")
  ).toHaveLength(1);
  expect(
    events.filter((event) => event === "video-track-stopped")
  ).toHaveLength(1);
  await stopPromise;
  expect(latest?.captureEnded).toBe(true);
  expect(latest?.journeyOutcome).toBe("terminal-restart");
  expect(
    events.filter((event) => event === "audio-track-stopped")
  ).toHaveLength(1);
  expect(
    events.filter((event) => event === "video-track-stopped")
  ).toHaveLength(1);
});

it("handles duplicate recorder errors with one physical cleanup", async () => {
  installBrowserGlobals();
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: async () => new Response(null, { status: 201 }),
  });

  render(React.createElement(RecordingHost));
  await act(async () => {
    await latest?.initialize();
  });
  await waitFor(() => expect(latest?.isReady).toBe(true));
  let stopPromise: Promise<void> | undefined;
  await act(async () => {
    await latest?.start();
    FakeMediaRecorder.last?.emitError();
    stopPromise = latest?.stop();
    await Promise.resolve();
  });
  expect(latest?.captureEnded).toBe(true);
  expect(latest?.isReady).toBe(false);
  expect(latest?.stream).toBe(null);
  expect(
    events.filter((event) => event === "audio-track-stopped")
  ).toHaveLength(1);
  expect(
    events.filter((event) => event === "video-track-stopped")
  ).toHaveLength(1);
  expect(events.filter((event) => event === "capture-ended")).toHaveLength(0);
  await waitFor(() => expect(finalizeCalls).toBe(1));
  await act(async () => {
    resolveFinalization?.();
    await stopPromise;
  });
  expect(latest?.captureEnded).toBe(true);
  expect(
    events.filter((event) => event === "audio-track-stopped")
  ).toHaveLength(1);
  expect(
    events.filter((event) => event === "video-track-stopped")
  ).toHaveLength(1);
});

it("durably resets a typed missing recovered recording", async () => {
  const storage = installBrowserGlobals();
  const session = {
    recorderMimeType: "video/webm",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 1, segmentId: "segment" }],
    sessionId: "session-1",
    status: "recording" as const,
  };
  storage.sessions.set(session.sessionId, session);
  storage.parts.set("session-1:segment:0", {
    blob: new Blob(["captured"], { type: "video/webm" }),
    id: "session-1:segment:0",
    mediaType: "video/webm",
    segmentId: "segment",
    sequence: 0,
    sessionId: "session-1",
  });
  manifestLookup = () => Promise.resolve({ kind: "missing" });
  render(React.createElement(RecordingHost));
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("missing-recovery");
  });
  expect(latest?.canResetRecoveredRecording).toBe(true);
  await act(async () => {
    await latest?.resetRecoveredRecording();
  });
  expect(storage.sessions.size).toBe(0);
  expect(storage.parts.size).toBe(0);
  expect(latest?.journeyOutcome).toBe("none");
  expect(latest?.recovered).toBe(false);
  expect(latest?.canResetRecoveredRecording).toBe(false);
});

it("revokes reset after a successful lookup and preserves it after transport failure", async () => {
  const storage = installBrowserGlobals();
  const session = {
    recorderMimeType: "video/webm",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 1, segmentId: "segment" }],
    sessionId: "session-1",
    status: "recording" as const,
  };
  storage.sessions.set(session.sessionId, session);
  manifestLookup = () => Promise.resolve({ kind: "missing" });
  render(React.createElement(RecordingHost));
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("missing-recovery");
  });
  manifestLookup = () =>
    Promise.resolve({
      kind: "found",
      manifest: {
        segments: [
          {
            id: "segment",
            parts: [{ checksum: "checksum", sequence: 0 }],
          },
        ],
        sessionId: "session-1",
      },
    });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("none");
  });
  expect(latest?.canResetRecoveredRecording).toBe(false);
  manifestLookup = () => Promise.resolve({ kind: "missing" });
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("missing-recovery");
  });
  manifestLookup = () => {
    throw new Error("deployment unavailable");
  };
  await act(async () => {
    window.dispatchEvent(new Event("online"));
    await Promise.resolve();
  });
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("missing-recovery");
  });
  expect(latest?.canResetRecoveredRecording).toBe(true);
});

it("allows reset for terminal recovery with a retained session", async () => {
  const storage = installBrowserGlobals();
  const session = {
    recorderMimeType: "video/webm",
    requestedMimeType: "video/webm",
    segments: [{ partCount: 1, segmentId: "segment" }],
    sessionId: "session-1",
    status: "recording" as const,
  };
  storage.sessions.set(session.sessionId, session);
  manifestLookup = () =>
    Promise.resolve({
      kind: "found",
      manifest: { segments: [], sessionId: "session-1" },
    });
  render(React.createElement(RecordingHost));
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("terminal-restart");
  });
  expect(latest?.canResetRecoveredRecording).toBe(true);
  await act(async () => {
    await latest?.resetRecoveredRecording();
  });
  expect(storage.sessions.size).toBe(0);
  expect(latest?.canResetRecoveredRecording).toBe(false);
});

it("does not offer reset for terminal recovery without a complete session", async () => {
  const storage = installBrowserGlobals();
  const session = {
    recorderMimeType: "video/webm",
    requestedMimeType: "video/webm",
    segments: [],
    sessionId: "session-1",
    status: "recording" as const,
  };
  storage.sessions.set(session.sessionId, session);
  storage.parts.set("session-1:segment:0", {
    blob: new Blob(["captured"], { type: "video/webm" }),
    id: "session-1:segment:0",
    mediaType: "video/webm",
    segmentId: "segment",
    sequence: 0,
    sessionId: "session-1",
  });
  manifestLookup = () =>
    Promise.resolve({
      kind: "found",
      manifest: {
        segments: [
          {
            id: "segment",
            parts: [{ checksum: "conflicting", sequence: 0 }],
          },
        ],
        sessionId: "session-1",
      },
    });
  render(React.createElement(RecordingHost));
  await waitFor(() => {
    expect(latest?.journeyOutcome).toBe("terminal-restart");
  });
  expect(latest?.canResetRecoveredRecording).toBe(false);
  await expect(latest?.resetRecoveredRecording()).rejects.toThrow(
    "cannot be reset"
  );
  expect(storage.sessions.size).toBe(1);
  expect(storage.parts.size).toBe(1);
});

function mountAdmittedHost(options?: {
  fetch?: typeof fetch;
  probeFails?: boolean;
  storage?: {
    estimate?: { quota?: number; usage?: number };
    persist?: boolean;
    persisted?: boolean;
  };
  writeFailsAfterPart?: number;
}) {
  const storage = installBrowserGlobals({
    probeFails: options?.probeFails,
    storage: options?.storage,
    writeFailsAfterPart: options?.writeFailsAfterPart,
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(globalThis.navigator, "mediaDevices", {
    configurable: true,
    value: { getUserMedia: async () => stream },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value:
      options?.fetch ??
      (() => Promise.resolve(new Response(null, { status: uploadStatus }))),
  });
  const view = render(React.createElement(RecordingHost));
  return Object.assign(storage, { rerender: view.rerender });
}

it("admits capture after a successful preflight", async () => {
  mountAdmittedHost();
  await act(async () => {
    await latest?.initialize();
  });
  expect(latest?.recordingPreflightState).toBe("ready");
  await act(async () => {
    await latest?.start();
  });
  expect(latest?.isRecording).toBe(true);
});

it("blocks Start when persistence is denied", async () => {
  const storage = {
    estimate: vi.fn().mockResolvedValue({ quota: 1_000_000_000, usage: 10 }),
    persist: vi.fn().mockResolvedValue(false),
    persisted: vi.fn().mockResolvedValue(false),
  };
  mountAdmittedHost();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: storage,
  });
  await act(async () => {
    await latest?.initialize();
  });
  storage.persisted.mockResolvedValueOnce(false);
  storage.persist.mockResolvedValueOnce(false);
  await act(async () => {
    await latest?.retryRecordingPreflight();
  });
  expect(latest?.recordingPreflightState).toBe("blocked");
  await act(async () => {
    await latest?.start();
  });
  expect(FakeMediaRecorder.last?.state).not.toBe("recording");
  expect(latest?.isRecording).toBe(false);
});

it("does not start when storage APIs are missing", async () => {
  mountAdmittedHost();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: undefined,
  });
  await act(async () => {
    await latest?.initialize();
  });
  expect(latest?.recordingPreflightState).toBe("blocked");
  await act(async () => {
    await latest?.start();
  });
  expect(latest?.isRecording).toBe(false);
});

it("does not start when the storage estimate is not finite", async () => {
  mountAdmittedHost({
    storage: { estimate: { quota: Number.NaN, usage: 10 } },
  });
  await act(async () => {
    await latest?.initialize();
  });
  expect(latest?.recordingPreflightState).toBe("blocked");
  await act(async () => {
    await latest?.start();
  });
  expect(latest?.isRecording).toBe(false);
});

it("does not start when headroom is insufficient", async () => {
  mountAdmittedHost({
    storage: { estimate: { quota: 100, usage: 0 } },
  });
  await act(async () => {
    await latest?.initialize();
  });
  expect(latest?.recordingPreflightState).toBe("blocked");
  await act(async () => {
    await latest?.start();
  });
  expect(latest?.isRecording).toBe(false);
});

it("does not start when the IndexedDB probe rejects", async () => {
  mountAdmittedHost({ probeFails: true });
  await act(async () => {
    await latest?.initialize();
  });
  expect(latest?.recordingPreflightState).toBe("blocked");
  await act(async () => {
    await latest?.start();
  });
  expect(latest?.isRecording).toBe(false);
});

it("persists the terminal part, drains, then finalizes after a candidate stop", async () => {
  const calls: string[] = [];
  let resolveTerminalUpload = (_value: Response) => undefined;
  const terminalUpload = {
    promise: new Promise<Response>((resolve) => {
      resolveTerminalUpload = resolve;
    }),
    resolve: (value: Response) => resolveTerminalUpload(value),
  };
  mountAdmittedHost({
    fetch: async (input) => {
      const url = input.toString();
      calls.push(url);
      if (calls.length === 2) {
        return await terminalUpload.promise;
      }
      return new Response(null, { status: 204 });
    },
  });
  await act(async () => {
    await latest?.initialize();
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("normal");
  await waitFor(() => expect(calls).toHaveLength(1));
  let stopPromise: Promise<void> | undefined;
  await act(async () => {
    stopPromise = latest?.stop();
    await Promise.resolve();
  });
  await waitFor(() => expect(calls).toHaveLength(2));
  expect(finalizeCalls).toBe(0);
  expect(latest?.recordingStopReason).toBe("candidate");
  terminalUpload.resolve(new Response(null, { status: 204 }));
  await waitFor(() => expect(finalizeCalls).toBe(1));
  await act(async () => {
    resolveFinalization?.();
    await stopPromise;
  });
});

it("offers a manual retry when finalization fails", async () => {
  finalizeMode = "failed";
  mountAdmittedHost();
  await act(async () => {
    await latest?.initialize();
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("normal");
  await act(async () => {
    await latest?.stop();
  });
  await waitFor(() => expect(finalizeCalls).toBe(1));
  await act(() => {
    resolveFinalization?.();
  });
  await waitFor(() => expect(latest?.finalization?.state).toBe("failed"));
  expect(latest?.journeyOutcome).toBe("manual-retry");
});

it("clears incomplete finalization when remote status becomes ready", async () => {
  finalizeMode = "queued";
  const view = mountAdmittedHost();
  await act(async () => {
    await latest?.initialize();
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("normal");
  await act(async () => {
    await latest?.stop();
  });
  await waitFor(() => expect(finalizeCalls).toBe(1));
  await act(() => {
    resolveFinalization?.();
  });
  await waitFor(() =>
    expect(latest?.hasIncompleteRecordingFinalization).toBe(true)
  );
  remoteStatus = "ready";
  view.rerender(React.createElement(RecordingHost));
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
  expect(latest?.hasIncompleteRecordingFinalization).toBe(false);
});

it("safety-stops before the next normal part would breach the admitted policy", async () => {
  const policy = getRecordingStoragePolicy(128_000, 1_000_000);
  if (!policy) {
    throw new Error("expected policy");
  }
  const storage = installStorage({
    estimate: { quota: 1_000_000_000, usage: 10 },
  });
  mountAdmittedHost();
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: storage,
  });
  await act(async () => {
    await latest?.initialize();
    await latest?.start();
  });
  storage.estimate.mockResolvedValue({
    quota: policy.predictedPartBytes * 2 + policy.safetyMarginBytes,
    usage: 0,
  });
  FakeMediaRecorder.last?.emitData("normal");
  await waitFor(() => expect(latest?.recordingStopReason).toBe("capacity"));
  expect(events).toContain("audio-track-stopped");
  expect(events).toContain("video-track-stopped");
  await waitFor(() => expect(finalizeCalls).toBe(1));
  await act(() => {
    resolveFinalization?.();
  });
});

it("treats an IndexedDB write failure as a save failure, not a capacity stop", async () => {
  const durable = mountAdmittedHost({ writeFailsAfterPart: 1 });
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
    await latest?.initialize();
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("first");
  await waitFor(() => expect(latest?.hasUnsentRecordingMedia).toBe(true));
  FakeMediaRecorder.last?.emitData("second");
  await waitFor(() => expect(latest?.recordingStopReason).toBe("save-failure"));
  expect(events).toContain("audio-track-stopped");
  expect(events).toContain("video-track-stopped");
  expect(latest?.finalization?.state).not.toBe("ready");
  expect(
    [...durable.parts.values()].some(
      (value) => (value as { sequence?: number }).sequence === 0
    )
  ).toBe(true);
});

it("reconciles before reconnect drain", async () => {
  const calls: string[] = [];
  let resolveManifest = (_value: RecordingManifestLookup) => undefined;
  const manifestReady = {
    promise: new Promise<RecordingManifestLookup>((resolve) => {
      resolveManifest = resolve;
    }),
    resolve: (value: RecordingManifestLookup) => resolveManifest(value),
  };
  manifestLookup = () => manifestReady.promise;
  mountAdmittedHost({
    fetch: async (input) => {
      calls.push(input.toString());
      return await new Promise<Response>(() => undefined);
    },
  });
  await act(async () => {
    window.dispatchEvent(new Event("offline"));
    await latest?.initialize();
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("offline-part");
  await waitFor(() => expect(latest?.hasUnsentRecordingMedia).toBe(true));
  expect(latest?.recordingDeliveryPhase).toBe("offline");
  const putCountBeforeOnline = calls.length;
  await act(() => {
    Object.defineProperty(globalThis.navigator, "onLine", {
      configurable: true,
      value: true,
    });
    window.dispatchEvent(new Event("online"));
  });
  await waitFor(() =>
    expect(latest?.recordingDeliveryPhase).toBe("reconnecting")
  );
  expect(calls).toHaveLength(putCountBeforeOnline);
  manifestReady.resolve({
    kind: "found",
    manifest: {
      segments: [{ id: "segment", parts: [] }],
      sessionId: "held",
    },
  });
  await waitFor(() => expect(latest?.recordingDeliveryPhase).toBe("saving"));
});

it("reports retry without hiding retained media", async () => {
  mountAdmittedHost({
    fetch: async () => new Response(null, { status: 503 }),
  });
  await act(async () => {
    await latest?.initialize();
    await latest?.start();
  });
  FakeMediaRecorder.last?.emitData("retry-part");
  await waitFor(() => expect(latest?.recordingDeliveryPhase).toBe("retrying"));
  expect(latest?.hasUnsentRecordingMedia).toBe(true);
});
