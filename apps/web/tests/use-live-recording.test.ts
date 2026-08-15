import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type UseLiveRecordingResult,
  useLiveRecording,
} from "../src/recording/live-recording";
import type {
  RecordingCommands,
  RecordingFinalizationState,
} from "../src/recording/recording-commands";

interface Records {
  parts: Map<string, unknown>;
  sessions: Map<string, unknown>;
}
let latest: UseLiveRecordingResult | null = null;
let finalizeFailure = false;
let createSessionOverride: (() => Promise<void>) | null = null;
let finalizeCalls = 0;
let statusCalls = 0;

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((nextResolve) => {
    resolve = nextResolve;
  });
  return { promise, resolve };
};

const commands = (): RecordingCommands => ({
  appendSegment: vi.fn().mockResolvedValue(undefined),
  createSession: vi.fn(() => createSessionOverride?.() ?? Promise.resolve()),
  finalizeSession: vi.fn().mockResolvedValue({ status: "ready" }),
  getManifest: vi.fn().mockResolvedValue({ kind: "missing" }),
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

function mount(
  writeFailsAfterPart = Number.POSITIVE_INFINITY,
  statusResults: Array<RecordingFinalizationState | null> = [],
  finalizeStatus: RecordingFinalizationState = "ready"
) {
  const records = installIndexedDb(writeFailsAfterPart);
  Object.defineProperty(navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(navigator, "storage", {
    configurable: true,
    value: {
      estimate: vi.fn().mockResolvedValue({ quota: 1_000_000_000, usage: 10 }),
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
      getUserMedia: vi.fn(async () => ({
        getTracks: () => [{ stop: vi.fn() }],
      })),
    },
  });
  Object.defineProperty(globalThis, "fetch", {
    configurable: true,
    value: vi.fn(async () => new Response(null, { status: 204 })),
  });
  const recordingCommands = commands();
  recordingCommands.getStatus = vi.fn(() => {
    statusCalls += 1;
    return Promise.resolve(statusResults.shift() ?? null);
  });
  recordingCommands.finalizeSession = vi.fn(() => {
    finalizeCalls += 1;
    if (finalizeFailure) {
      return Promise.reject(new Error("finalization unavailable"));
    }
    return Promise.resolve({ status: finalizeStatus });
  });
  function Host() {
    latest = useLiveRecording(recordingCommands);
    return null;
  }
  render(React.createElement(Host));
  return records;
}

afterEach(() => {
  cleanup();
  latest = null;
  finalizeFailure = false;
  createSessionOverride = null;
  finalizeCalls = 0;
  statusCalls = 0;
  FakeMediaRecorder.last = null;
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
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
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

it("shares an in-flight rendered start", async () => {
  const create = deferred<void>();
  createSessionOverride = () => create.promise;
  mount();
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  let first: Promise<void> | undefined;
  let second: Promise<void> | undefined;
  act(() => {
    first = latest?.start();
    second = latest?.start();
  });
  create.resolve();
  await act(async () => {
    await Promise.all([first, second]);
  });
});

it("keeps remote failed finalization retryable", async () => {
  mount(Number.POSITIVE_INFINITY, [], "failed");
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => latest?.start());
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("failed");
  await act(() => latest?.stop());
  await waitFor(() => expect(latest?.finalization?.state).toBe("failed"));
  expect(latest?.hasIncompleteRecordingFinalization).toBe(true);
});

it("offers manual retry after rendered finalization failure", async () => {
  finalizeFailure = true;
  mount();
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
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
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
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
  await act(async () => {
    latest?.initialize();
    await Promise.resolve();
  });
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  act(() => {
    latest?.start();
  });
  await waitFor(() => expect(latest?.isRecording).toBe(true));
  FakeMediaRecorder.last?.emitPart("first");
  await waitFor(() => expect(latest?.recordingStopReason).toBe("save-failure"));
  expect(latest?.recordingStopReason).toBe("save-failure");
  expect(latest?.saveState).toBe("error");
});
