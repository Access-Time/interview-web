import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  type UseLiveRecordingResult,
  useLiveRecording,
} from "../src/recording/live-recording";

interface Records {
  parts: Map<string, unknown>;
  sessions: Map<string, unknown>;
}
let latest: UseLiveRecordingResult | null = null;

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
    this.onstop?.();
  }
  emitPart(value: string) {
    this.ondataavailable?.({
      data: new Blob([value], { type: this.mimeType }),
    } as BlobEvent);
  }
}

function mount(writeFailsAfterPart = Number.POSITIVE_INFINITY) {
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
  const finalizeSession = vi.fn();
  function Host() {
    latest = useLiveRecording({
      appendSegment: (_input, callbacks) => callbacks.onSuccess(undefined),
      createSession: (_input, callbacks) => callbacks.onSuccess(undefined),
      finalizeSession,
    });
    return null;
  }
  render(React.createElement(Host));
  return records;
}

afterEach(() => {
  cleanup();
  latest = null;
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
    latest = useLiveRecording({
      appendSegment: vi.fn(),
      createSession: vi.fn(),
      finalizeSession: vi.fn(),
    });
    return null;
  }
  render(React.createElement(Host));
  await act(() => latest?.initialize());
  expect(latest?.error).toContain("permission denied");
  expect("recordingDeliveryPhase" in (latest ?? {})).toBe(false);
});

it("completes a normal rendered recording", async () => {
  mount();
  await act(() => latest?.initialize());
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  expect(latest?.stop).toEqual(expect.any(Function));
  expect(latest?.finalization).toBeNull();
});

it("offers manual retry after rendered finalization failure", async () => {
  mount();
  await act(() => latest?.initialize());
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  await act(async () => {
    await latest?.retryFinalization();
  });
  expect(latest?.retryFinalization).toEqual(expect.any(Function));
});

it("reports a rendered local write failure", async () => {
  mount(1);
  await act(() => latest?.initialize());
  await waitFor(() => expect(latest?.recordingPreflightState).toBe("ready"));
  expect(latest?.saveState).toBe("healthy");
  expect(latest?.hasUnsentRecordingMedia).toBe(false);
});
