import { act, cleanup, render, waitFor } from "@testing-library/react";
import React from "react";
import { afterEach, expect, it } from "vitest";
import {
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

function installIndexedDb() {
  const records = {
    parts: new Map<string, unknown>(),
    sessions: new Map<string, unknown>(),
  };
  const storeNames = new Set<string>();

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
}

function installBrowserGlobals() {
  for (const property of globalProperties) {
    originalDescriptors.set(
      property,
      Object.getOwnPropertyDescriptor(globalThis, property)
    );
  }
  installIndexedDb();
}

const events: string[] = [];
const tracks = [
  { kind: "audio", stop: () => events.push("audio-track-stopped") },
  { kind: "video", stop: () => events.push("video-track-stopped") },
] as unknown as MediaStreamTrack[];
const stream = { getTracks: () => tracks } as unknown as MediaStream;

class FakeMediaRecorder extends EventTarget {
  static isTypeSupported() {
    return true;
  }

  mimeType = "video/webm";
  ondataavailable: ((event: BlobEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onstop: ((event: Event) => void) | null = null;
  state: RecordingState = "inactive";

  constructor(_stream: MediaStream, _options?: MediaRecorderOptions) {
    super();
  }

  start() {
    this.state = "recording";
  }

  stop() {
    this.state = "inactive";
    this.ondataavailable?.({
      data: new Blob(["captured"], { type: this.mimeType }),
    } as BlobEvent);
    events.push("capture-ended");
    const stopEvent = new NodeEvent("stop");
    this.dispatchEvent(stopEvent);
    this.onstop?.(stopEvent);
  }
}

let latest: UseLiveRecordingResult | null = null;
let finalizeCalls = 0;
let resolveFinalization: (() => void) | null = null;

function RecordingHost() {
  latest = useLiveRecording({
    appendSegment: () => Promise.resolve(),
    createSession: () => Promise.resolve(),
    finalizeSession: async () => {
      finalizeCalls += 1;
      await new Promise<void>((resolve) => {
        resolveFinalization = resolve;
      });
      return { status: "ready" };
    },
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
  resolveFinalization = null;
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
    value: async () => new Response(null, { status: 201 }),
  });

  render(React.createElement(RecordingHost));
  await waitFor(() => expect(latest).not.toBe(null));

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
    "capture-ended",
    "audio-track-stopped",
    "video-track-stopped",
  ]);
  expect(latest?.stream).toBe(null);
  expect(latest?.isReady).toBe(false);
  await act(async () => {
    resolveFinalization?.();
    await stopPromise;
  });
});
