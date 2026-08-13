import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
import { act, cleanup, render, waitFor } from "@testing-library/react";
// @ts-expect-error jsdom ships no declarations in this workspace.
import { JSDOM } from "jsdom";
import React from "react";
import {
  type UseLiveRecordingResult,
  useLiveRecording,
} from "../src/recording/live-recording.ts";

const originalDescriptors = new Map<string, PropertyDescriptor | undefined>();
const NodeEvent = Event;
const globalProperties = [
  "window",
  "document",
  "HTMLElement",
  "Event",
  "navigator",
  "indexedDB",
  "MediaRecorder",
  "fetch",
  "IS_REACT_ACT_ENVIRONMENT",
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
  const dom = new JSDOM("<!doctype html><html><body></body></html>", {
    url: "http://localhost",
  });
  for (const property of globalProperties) {
    originalDescriptors.set(
      property,
      Object.getOwnPropertyDescriptor(globalThis, property)
    );
  }
  for (const [property, value] of Object.entries({
    document: dom.window.document,
    Event: dom.window.Event,
    HTMLElement: dom.window.HTMLElement,
    navigator: dom.window.navigator,
    window: dom.window,
  })) {
    Object.defineProperty(globalThis, property, {
      configurable: true,
      value,
      writable: true,
    });
  }
  Object.defineProperty(dom.window.navigator, "onLine", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", {
    configurable: true,
    value: true,
    writable: true,
  });
  installIndexedDb();
  return dom;
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

function RecordingHost() {
  latest = useLiveRecording({
    appendSegment: () => Promise.resolve(),
    createSession: () => Promise.resolve(),
    finalizeSession: () => {
      finalizeCalls += 1;
      return Promise.resolve({ status: "ready" });
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
});

test("normal stop releases tracks after capture and retains submission", async () => {
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
  await waitFor(() => assert.notEqual(latest, null));

  await act(async () => {
    await latest?.initialize();
  });
  await waitFor(() => assert.equal(latest?.isReady, true));

  await act(async () => {
    await latest?.start();
  });
  await waitFor(() => assert.equal(latest?.isRecording, true));

  await act(async () => {
    await latest?.stop();
  });

  await waitFor(() => assert.equal(finalizeCalls, 1));
  assert.deepEqual(events, [
    "capture-ended",
    "audio-track-stopped",
    "video-track-stopped",
  ]);
  assert.equal(latest?.stream, null);
  assert.equal(latest?.isReady, false);
});
