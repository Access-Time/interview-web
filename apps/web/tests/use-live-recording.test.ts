import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import type { RecordingSession } from "../src/recording/live-recording";
import {
  type UseLiveRecordingResult,
  useLiveRecording,
} from "../src/recording/live-recording";
import type {
  RecordingCommands,
  RecordingFinalizationState,
  RecordingManifestLookup,
} from "../src/recording/recording-commands";

interface Records {
  parts: Map<string, unknown>;
  sessions: Map<string, unknown>;
}
let latest: UseLiveRecordingResult | null = null;
let finalizeFailure = false;
let finalizeStatuses: RecordingFinalizationState[] = [];
let createSessionOverride: (() => Promise<void>) | null = null;
let manifestOverride: (() => Promise<RecordingManifestLookup>) | null = null;
let storageEstimateOverride:
  | (() => Promise<{ quota?: number; usage?: number }>)
  | null = null;
let cleanupPromise: Promise<void> | null = null;
let mediaOverride: (() => Promise<MediaStream>) | null = null;
let screenOverride: (() => Promise<MediaStream>) | null = null;
let lastCommands: RecordingCommands | null = null;
let unmountHook: (() => void) | null = null;
let finalizeCalls = 0;
let statusCalls = 0;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((nextResolve, nextReject) => {
    resolve = nextResolve;
    reject = nextReject;
  });
  return { promise, reject, resolve };
};

const commands = (): RecordingCommands => ({
  appendSegment: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn(() => createSessionOverride?.() ?? Promise.resolve()),
  finalizeSession: vi.fn().mockResolvedValue({ status: "ready" }),
  getManifest: vi.fn(() =>
    manifestOverride
      ? manifestOverride()
      : Promise.resolve<RecordingManifestLookup>({ kind: "missing" })
  ),
  getStatus: vi.fn().mockResolvedValue(null),
});

it("exposes awaitable recording commands", async () => {
  const host = commands();
  await expect(
    host.appendSegment({
      recorderMimeType: null,
      requestedMimeType: null,
      segmentId: "segment",
      sessionId: "session",
    })
  ).resolves.toBeUndefined();
  await expect(
    host.createSession({
      recorderMimeType: null,
      requestedMimeType: null,
      segmentId: "segment",
      sessionId: "session",
    })
  ).resolves.toBeUndefined();
  await expect(
    host.finalizeSession({ segments: [], sessionId: "session" })
  ).resolves.toEqual({ status: "ready" });
  await expect(host.getManifest({ sessionId: "session" })).resolves.toEqual({
    kind: "missing",
  });
  await expect(host.getStatus({ sessionId: "session" })).resolves.toBeNull();
});

function installIndexedDb(writeFailsAfterPart = Number.POSITIVE_INFINITY) {
  const records: Records = { parts: new Map(), sessions: new Map() };
  let writes = 0;
  const request = (result: unknown) => {
    const value = { onsuccess: null as (() => void) | null, result };
    queueMicrotask(() => value.onsuccess?.());
    return value as unknown as IDBRequest;
  };
  const database = {
    createObjectStore: () => ({}),
    objectStoreNames: { contains: () => false },
    transaction: (_names: string | string[]) => {
      const transaction = {
        error: null,
        objectStore: (name: "parts" | "sessions") => ({
          delete: (key: IDBValidKey) => {
            if (cleanupPromise && name === "sessions") {
              cleanupPromise.then(
                () => {
                  records[name].delete(String(key));
                  queueMicrotask(() => transaction.oncomplete?.());
                },
                () =>
                  queueMicrotask(() => {
                    const onerror = transaction.onerror as (() => void) | null;
                    onerror?.();
                  })
              );
              return;
            }
            records[name].delete(String(key));
            queueMicrotask(() => transaction.oncomplete?.());
          },
          getAll: () => request([...records[name].values()]),
          put: (value: unknown) => {
            const item = value as { id?: string; sessionId?: string };
            const key = name === "parts" ? item.id : item.sessionId;
            if (name === "parts" && key !== "__recording_preflight_probe__") {
              if (writes >= writeFailsAfterPart) {
                throw new Error("IndexedDB write failed");
              }
              writes += 1;
            }
            if (key) {
              records[name].set(key, value);
            }
            queueMicrotask(() => transaction.oncomplete?.());
          },
        }),
        onabort: null,
        oncomplete: null as (() => void) | null,
        onerror: null,
      };
      return transaction;
    },
  } as unknown as IDBDatabase;
  Object.defineProperty(globalThis, "indexedDB", {
    configurable: true,
    value: {
      open: () => {
        const openRequest = {
          onsuccess: null as (() => void) | null,
          onupgradeneeded: null as (() => void) | null,
          result: database,
        };
        queueMicrotask(() => {
          openRequest.onupgradeneeded?.();
          queueMicrotask(() => openRequest.onsuccess?.());
        });
        return openRequest;
      },
    },
  });
  return records;
}

class FakeMediaRecorder extends EventTarget {
  static last: FakeMediaRecorder | null = null;
  static starts = 0;
  static isTypeSupported = () => true;
  audioBitsPerSecond = 128_000;
  videoBitsPerSecond = 1_000_000;
  mimeType = "video/webm";
  state: RecordingState = "inactive";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor() {
    super();
    FakeMediaRecorder.last = this;
  }
  start() {
    FakeMediaRecorder.starts += 1;
    this.state = "recording";
  }
  stop() {
    this.state = "inactive";
    this.emitPart("terminal");
    this.dispatchEvent(new Event("stop"));
    this.onstop?.();
  }
  emitPart(value: string) {
    this.ondataavailable?.({
      data: new Blob([value], { type: this.mimeType }),
    } as BlobEvent);
  }
}

function stubStream(): MediaStream {
  const tracks = [
    {
      addEventListener: vi.fn(),
      kind: "video" as const,
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    },
    {
      addEventListener: vi.fn(),
      kind: "audio" as const,
      removeEventListener: vi.fn(),
      stop: vi.fn(),
    },
  ];
  return {
    getAudioTracks: () => tracks.filter((track) => track.kind === "audio"),
    getTracks: () => tracks,
    getVideoTracks: () => tracks.filter((track) => track.kind === "video"),
  } as unknown as MediaStream;
}

function mount(
  writeFailsAfterPart = Number.POSITIVE_INFINITY,
  statusResults: Array<RecordingFinalizationState | null> = [],
  finalizeStatus: RecordingFinalizationState = "ready",
  initialSessions: RecordingSession[] = []
) {
  const records = installIndexedDb(writeFailsAfterPart);
  for (const initialSession of initialSessions) {
    records.sessions.set(initialSession.sessionId, initialSession);
  }
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      estimate: vi.fn(() =>
        storageEstimateOverride
          ? storageEstimateOverride()
          : Promise.resolve({ quota: 1_000_000_000, usage: 10 })
      ),
      persist: vi.fn().mockResolvedValue(true),
      persisted: vi.fn().mockResolvedValue(true),
    },
  });
  Object.defineProperty(globalThis, "MediaRecorder", {
    configurable: true,
    value: FakeMediaRecorder,
  });
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getDisplayMedia: vi.fn(
        () => screenOverride?.() ?? Promise.resolve(stubStream())
      ),
      getUserMedia: vi.fn(
        () => mediaOverride?.() ?? Promise.resolve(stubStream())
      ),
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: vi.fn(async () => new Response(null, { status: 204 })),
  });
  const recordingCommands = commands();
  lastCommands = recordingCommands;
  recordingCommands.getStatus = vi.fn(() => {
    statusCalls += 1;
    return Promise.resolve(statusResults.shift() ?? null);
  });
  recordingCommands.finalizeSession = vi.fn(() => {
    finalizeCalls += 1;
    if (finalizeFailure) {
      return Promise.reject(new Error("finalization unavailable"));
    }
    return Promise.resolve({
      status: finalizeStatuses.shift() ?? finalizeStatus,
    });
  });
  function Host() {
    latest = useLiveRecording(recordingCommands);
    return null;
  }
  const rendered = render(React.createElement(Host));
  unmountHook = rendered.unmount;
  return records;
}

async function enableCapture() {
  await act(async () => {
    await latest?.initialize();
  });
}

afterEach(() => {
  cleanup();
  latest = null;
  finalizeFailure = false;
  createSessionOverride = null;
  finalizeCalls = 0;
  finalizeStatuses = [];
  statusCalls = 0;
  FakeMediaRecorder.last = null;
  FakeMediaRecorder.starts = 0;
  manifestOverride = null;
  storageEstimateOverride = null;
  cleanupPromise = null;
  mediaOverride = null;
  screenOverride = null;
  lastCommands = null;
  unmountHook = null;
});

it("reports a preflight access error without delivery state", async () => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.reject(new Error("permission denied"))),
    },
  });
  function Host() {
    latest = useLiveRecording(commands());
    return null;
  }
  render(React.createElement(Host));
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
  await waitFor(() => expect(latest?.error).toContain("permission denied"));
  expect("recordingDeliveryPhase" in (latest ?? {})).toBe(false);
});

it("completes a normal rendered recording", async () => {
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  act(() => {
    latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("normal");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
  expect(finalizeCalls).toBe(1);
});

it("completes a screen-only recording without enabling the camera", async () => {
  mount();
  await act(async () => {
    await latest?.shareScreen();
  });
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  expect(latest?.captureSource).toBe("screen");
  expect(latest?.isReady).toBe(true);
  act(() => {
    latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("screen");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
});

it("completes a screen-only recording without enabling the camera", async () => {
  mount();
  await act(async () => {
    await latest?.shareScreen();
  });
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  expect(latest?.captureSource).toBe("screen");
  expect(latest?.isReady).toBe(true);
  act(() => {
    latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("screen");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
});

const storedRecording = (
  sessionId: string,
  status: "recording" | "sealed" = "recording"
): RecordingSession => ({
  recorderMimeType: "video/webm",
  requestedMimeType: "video/webm",
  segments: [
    {
      partCount: status === "sealed" ? 1 : 0,
      segmentId: `${sessionId}-segment`,
    },
  ],
  sessionId,
  status,
});

it("waits for delayed recovery before making the remote start call", async () => {
  const manifest = deferred<RecordingManifestLookup>();
  manifestOverride = () => manifest.promise;
  mount(Number.POSITIVE_INFINITY, [], "ready", [storedRecording("recovered")]);
  let initialize: Promise<void> | undefined;
  await act(async () => {
    initialize = latest?.initialize();
    await Promise.resolve();
  });
  await waitFor(() => expect(lastCommands?.getManifest).toHaveBeenCalled());
  let start: Promise<void> | undefined;
  act(() => {
    start = latest?.start();
  });
  expect(lastCommands?.createSession).not.toHaveBeenCalled();
  await act(async () => {
    manifest.resolve({ kind: "missing" });
    await initialize;
    await start;
  });
  expect(lastCommands?.createSession).toHaveBeenCalledOnce();
});

it("automatically clears typed-missing recovery and returns to normal setup", async () => {
  manifestOverride = () => Promise.resolve({ kind: "missing" });
  const records = mount(Number.POSITIVE_INFINITY, [], "ready", [
    storedRecording("missing"),
  ]);
  await enableCapture();
  await waitFor(() => expect(latest?.canResetRecoveredRecording).toBe(false));
  expect(latest?.recovered).toBe(false);
  expect(records.sessions.has("missing")).toBe(false);
  await act(async () => latest?.start());
  expect(lastCommands?.createSession).toHaveBeenCalledOnce();
  expect(lastCommands?.appendSegment).not.toHaveBeenCalled();
});

it("keeps a non-missing recovery failure blocking through initialization and Start", async () => {
  manifestOverride = () => Promise.reject(new Error("manifest unavailable"));
  mount(Number.POSITIVE_INFINITY, [], "ready", [storedRecording("blocked")]);
  await enableCapture();
  await waitFor(() => expect(latest?.error).toContain("manifest unavailable"));
  await expect(latest?.start()).rejects.toThrow("manifest unavailable");
  expect(lastCommands?.createSession).not.toHaveBeenCalled();
  expect(lastCommands?.appendSegment).not.toHaveBeenCalled();
});

it("surfaces recovery failure before media acquisition and blocks Start", async () => {
  const media = deferred<MediaStream>();
  mediaOverride = () => media.promise;
  manifestOverride = () => Promise.reject(new Error("early recovery failed"));
  mount(Number.POSITIVE_INFINITY, [], "ready", [storedRecording("early")]);
  let initialize: Promise<void> | undefined;
  await act(async () => {
    initialize = latest?.initialize();
    await Promise.resolve();
  });
  await waitFor(() => expect(latest?.error).toContain("early recovery failed"));
  await act(async () => {
    await expect(latest?.start()).rejects.toThrow("early recovery failed");
  });
  expect(lastCommands?.createSession).not.toHaveBeenCalled();
  await act(async () => {
    media.resolve({ getTracks: () => [] } as unknown as MediaStream);
    await initialize;
  });
});

it("restores recovery failure after an early device error and later media success", async () => {
  const manifest = deferred<RecordingManifestLookup>();
  manifestOverride = () => manifest.promise;
  mediaOverride = () => Promise.reject(new Error("device unavailable"));
  mount(Number.POSITIVE_INFINITY, [], "ready", [storedRecording("precedence")]);
  await act(async () => latest?.initialize());
  await waitFor(() => expect(latest?.error).toContain("device unavailable"));
  await act(async () => {
    manifest.reject(new Error("recovery unavailable"));
    await Promise.resolve();
  });
  mediaOverride = () =>
    Promise.resolve({
      getTracks: () => [{ stop: vi.fn() }],
    } as unknown as MediaStream);
  await enableCapture();
  await waitFor(() => expect(latest?.error).toContain("recovery unavailable"));
  await act(async () => {
    await expect(latest?.start()).rejects.toThrow("recovery unavailable");
  });
  expect(lastCommands?.createSession).not.toHaveBeenCalled();
  expect(lastCommands?.appendSegment).not.toHaveBeenCalled();
});

it("blocks a fresh preflight without remote creation or recorder start", async () => {
  storageEstimateOverride = () => Promise.resolve({ quota: 1, usage: 1 });
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("blocked"));
  await act(async () => latest?.start());
  expect(lastCommands?.createSession).not.toHaveBeenCalled();
  expect(lastCommands?.appendSegment).not.toHaveBeenCalled();
  expect(FakeMediaRecorder.starts).toBe(0);
});

it("fails closed when unmount interrupts a fresh Start preflight", async () => {
  const pendingEstimate = deferred<{ quota?: number; usage?: number }>();
  let estimateCalls = 0;
  storageEstimateOverride = () => {
    estimateCalls += 1;
    return estimateCalls === 1
      ? Promise.resolve({ quota: 1_000_000_000, usage: 10 })
      : pendingEstimate.promise;
  };
  const records = mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  let start: Promise<void> | undefined;
  act(() => {
    start = latest?.start();
  });
  await waitFor(() => expect(estimateCalls).toBe(2));
  await act(async () => {
    unmountHook?.();
    pendingEstimate.resolve({ quota: 1, usage: 1 });
    await start;
  });
  expect(records.sessions.size).toBe(0);
  expect(lastCommands?.createSession).not.toHaveBeenCalled();
  expect(lastCommands?.appendSegment).not.toHaveBeenCalled();
  expect(FakeMediaRecorder.starts).toBe(0);
});

it("safety-stops after a fresh invalid capacity estimate", async () => {
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => latest?.start());
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  storageEstimateOverride = () =>
    Promise.resolve({ quota: Number.NaN, usage: 0 });
  FakeMediaRecorder.last?.emitPart("capacity");
  await waitFor(() => expect(latest?.recordingStopReason).toBe("capacity"));
  expect(latest?.isRecording).toBe(false);
});

it("safety-stops after a fresh valid low-capacity estimate", async () => {
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => latest?.start());
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  storageEstimateOverride = () => Promise.resolve({ quota: 10, usage: 0 });
  FakeMediaRecorder.last?.emitPart("low-capacity");
  await waitFor(() => expect(latest?.recordingStopReason).toBe("capacity"));
  expect(latest?.isRecording).toBe(false);
});

it("shares an in-flight rendered start", async () => {
  const create = deferred<void>();
  createSessionOverride = () => create.promise;
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  act(() => {
    first = latest?.start();
    second = latest?.start();
  });
  expect(first).toBe(second);
  await waitFor(() =>
    expect(lastCommands?.createSession).toHaveBeenCalledOnce()
  );
  expect(lastCommands?.createSession).toHaveBeenCalledOnce();
  create.resolve();
  await act(async () => {
    await Promise.all([first, second]);
  });
  expect(FakeMediaRecorder.starts).toBe(1);
});

it("keeps ready state when local cleanup fails", async () => {
  const cleanupDeferred = deferred<void>();
  cleanupPromise = cleanupDeferred.promise;
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => latest?.start());
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("cleanup");
  let stop: Promise<void> | undefined;
  act(() => {
    stop = latest?.stop();
  });
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
  expect(latest?.error).toBeNull();
  cleanupDeferred.reject(new Error("cleanup failed"));
  await act(async () => {
    await stop;
  });
  expect(latest?.error).toBe("Recording completed, but local cleanup failed.");
  expect(latest?.hasIncompleteRecordingFinalization).toBe(false);
});

it("submits every recovered sealed plan when each finalizes immediately", async () => {
  const plans = [
    storedRecording("sealed-a", "sealed"),
    storedRecording("sealed-b", "sealed"),
  ];
  mount(Number.POSITIVE_INFINITY, [], "ready", plans);
  await waitFor(() => expect(finalizeCalls).toBe(2));
  expect(lastCommands?.finalizeSession).toHaveBeenCalledTimes(2);
});

it("keeps remote failed finalization retryable", async () => {
  finalizeStatuses = ["failed", "ready"];
  mount(Number.POSITIVE_INFINITY, [], "failed");
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => latest?.start());
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("failed");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("failed"));
  expect(latest?.hasIncompleteRecordingFinalization).toBe(true);
  await act(() => latest?.retryFinalization());
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
  expect(finalizeCalls).toBe(2);
});

it("offers manual retry after rendered finalization failure", async () => {
  finalizeFailure = true;
  mount();
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  act(() => {
    latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("normal");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("failed"));
  expect(finalizeCalls).toBe(1);
  finalizeFailure = false;
  await act(() => latest?.retryFinalization());
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"));
  expect(finalizeCalls).toBe(2);
});

it("keeps polling through a missing status until finalization is ready", async () => {
  mount(Number.POSITIVE_INFINITY, [null, "queued", "ready"], "queued");
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => {
    await latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("normal");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("ready"), {
    timeout: 4000,
  });
  expect(statusCalls).toBe(3);
});

it("reports a rendered local write failure", async () => {
  mount(0);
  await enableCapture();
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  act(() => {
    latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("first");
  await waitFor(() => expect(latest?.recordingStopReason).toBe("save-failure"));
  expect(latest?.recordingStopReason).toBe("save-failure");
  expect(latest?.saveState).toBe("error");
  expect(finalizeCalls).toBe(0);
});
