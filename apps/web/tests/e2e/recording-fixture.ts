import { readFileSync } from "node:fs";
import path from "node:path";
import type {
  AppendRecordingSegmentInput,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingManifest,
  RecordingPlaybackSummary,
  RecordingStatus,
} from "@interview-web/db";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Page } from "@playwright/test";
import z from "zod";

const tinyWebm = readFileSync(
  path.join(import.meta.dirname, "fixtures/tiny.webm")
);
const recoveredSubmission = Buffer.concat([tinyWebm, tinyWebm]);

declare global {
  interface Window {
    __recordingTestState: { stoppedTracks: number };
    __recordingTestStorage?: { quota: number; usage: number };
    __testMediaRecorder?: { emitPart: (value?: string) => void };
  }
}

const procedure = os;
const recordingId = z.string().min(1).max(128);
const sessionInput = z.object({
  recorderMimeType: z.string().nullable().optional(),
  requestedMimeType: z.string().nullable().optional(),
  segmentId: recordingId,
  sessionId: recordingId,
});
const finalizeInput = z.object({
  segments: z
    .array(
      z.object({
        partCount: z.number().int().positive(),
        segmentId: recordingId,
      })
    )
    .min(1),
  sessionId: recordingId,
});

export interface CandidateBindingFixture {
  appendRecordingSegment: (
    input: AppendRecordingSegmentInput
  ) => Promise<unknown>;
  bindings: {
    finalizeRecording: (
      input: RecordingFinalizeInput
    ) => Promise<RecordingFinalizeResult>;
  };
  createCallCount: () => number;
  createRecordingSession: (
    input: AppendRecordingSegmentInput
  ) => Promise<unknown>;
  deferCreate: () => Deferred<void>;
  deferManifest: (sessionId: string) => Deferred<RecordingManifest>;
  getPlaybackSummary: (
    sessionId: string
  ) => Promise<RecordingPlaybackSummary | null>;
  getRecordingManifest: (
    sessionId: string
  ) => Promise<RecordingManifest | null>;
  getRecordingStatus: (sessionId: string) => Promise<RecordingStatus | null>;
  lastFinalizeInput: () => RecordingFinalizeInput | null;
  lastSessionId: () => string | null;
  markAllFailed: () => void;
  markAllReady: () => void;
  uploadedPartCount: () => number;
}

export interface Deferred<T> {
  promise: Promise<T>;
  reject: (error: unknown) => void;
  resolve: (value: T) => void;
}

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, reject, resolve };
}

const uploadedPartCounts = new WeakMap<CandidateBindingFixture, number>();

function recordUploadedPart(fixture: CandidateBindingFixture) {
  uploadedPartCounts.set(fixture, (uploadedPartCounts.get(fixture) ?? 0) + 1);
}

export function createCandidateBindings(): CandidateBindingFixture {
  const manifests = new Map<string, RecordingManifest>();
  const statuses = new Map<string, RecordingStatus>();
  const appendedSegments = new Map<string, AppendRecordingSegmentInput[]>();
  const manifestDeferrals = new Map<string, Deferred<RecordingManifest>>();
  let createCalls = 0;
  let createDeferral: Deferred<void> | undefined;
  let lastFinalize: RecordingFinalizeInput | null = null;
  let lastSession: string | null = null;

  const fixture: CandidateBindingFixture = {
    appendRecordingSegment: (input) => {
      const segments = appendedSegments.get(input.sessionId) ?? [];
      segments.push(input);
      appendedSegments.set(input.sessionId, segments);
      const manifest = manifests.get(input.sessionId);
      if (
        manifest &&
        !manifest.segments.some((segment) => segment.id === input.segmentId)
      ) {
        manifest.segments.push({
          createdAt: Date.now(),
          id: input.segmentId,
          index: segments.length,
          parts: [],
          recorderMimeType: input.recorderMimeType ?? null,
          requestedMimeType: input.requestedMimeType ?? null,
        });
      }
      return Promise.resolve({
        index: segments.length,
        recorderMimeType: input.recorderMimeType ?? null,
        requestedMimeType: input.requestedMimeType ?? null,
        segmentId: input.segmentId,
        sessionId: input.sessionId,
      });
    },
    bindings: {
      finalizeRecording: (input) => {
        lastFinalize = input;
        lastSession = input.sessionId;
        statuses.set(input.sessionId, { status: "queued" });
        return Promise.resolve({ status: "queued" });
      },
    },
    createCallCount: () => createCalls,
    createRecordingSession: async (input) => {
      createCalls += 1;
      lastSession = input.sessionId;
      await createDeferral?.promise;
      manifests.set(input.sessionId, {
        createdAt: Date.now(),
        segments: [],
        sessionId: input.sessionId,
      });
      appendedSegments.set(input.sessionId, []);
      return Promise.resolve({
        recorderMimeType: input.recorderMimeType ?? null,
        requestedMimeType: input.requestedMimeType ?? null,
        segmentId: input.segmentId,
        sessionId: input.sessionId,
      });
    },
    deferCreate: () => {
      createDeferral = deferred<void>();
      return createDeferral;
    },
    deferManifest: (sessionId) => {
      const pending = deferred<RecordingManifest>();
      manifestDeferrals.set(sessionId, pending);
      return pending;
    },
    getPlaybackSummary: (sessionId) => {
      const status = statuses.get(sessionId);
      if (status?.status !== "ready") {
        return Promise.resolve(null);
      }
      return Promise.resolve({
        createdAt: Date.now(),
        hasOutput: true,
        id: sessionId,
        outputByteSize: recoveredSubmission.byteLength,
        outputMediaType: "video/webm",
        status: "ready",
      });
    },
    getRecordingManifest: async (sessionId) => {
      const manifest = await manifestDeferrals.get(sessionId)?.promise;
      return manifest ?? manifests.get(sessionId) ?? null;
    },
    getRecordingStatus: (sessionId) =>
      Promise.resolve(statuses.get(sessionId) ?? null),
    lastFinalizeInput: () => lastFinalize,
    lastSessionId: () => lastSession,
    markAllFailed: () => {
      for (const sessionId of statuses.keys()) {
        statuses.set(sessionId, { status: "failed" });
      }
    },
    markAllReady: () => {
      for (const sessionId of statuses.keys()) {
        statuses.set(sessionId, { status: "ready" });
      }
    },
    uploadedPartCount: () => uploadedPartCounts.get(fixture) ?? 0,
  };

  uploadedPartCounts.set(fixture, 0);
  return fixture;
}

function createCandidateRecordingRouter(fixture: CandidateBindingFixture) {
  return {
    appendSegment: procedure
      .input(sessionInput)
      .handler(({ input }) => fixture.appendRecordingSegment(input)),
    create: procedure
      .input(sessionInput)
      .handler(({ input }) => fixture.createRecordingSession(input)),
    finalize: procedure
      .input(finalizeInput)
      .handler(({ input }) => fixture.bindings.finalizeRecording(input)),
    getManifest: procedure
      .input(z.object({ sessionId: recordingId }))
      .handler(async ({ input }) => {
        const manifest = await fixture.getRecordingManifest(input.sessionId);
        if (!manifest) {
          throw new ORPCError("RECORDING_NOT_FOUND");
        }
        return manifest;
      }),
    getPlaybackSummary: procedure
      .input(z.object({ sessionId: recordingId }))
      .handler(async ({ input }) => {
        const summary = await fixture.getPlaybackSummary(input.sessionId);
        if (!summary) {
          throw new ORPCError("RECORDING_NOT_FOUND");
        }
        return summary;
      }),
    getStatus: procedure
      .input(z.object({ sessionId: recordingId }))
      .handler(async ({ input }) => {
        const status = await fixture.getRecordingStatus(input.sessionId);
        if (!status) {
          throw new ORPCError("RECORDING_NOT_FOUND");
        }
        return status;
      }),
  };
}

export async function installRecordingApi(
  page: Page,
  fixture: CandidateBindingFixture,
  uploadStatus = 204,
  upload?: { mode: UploadMode }
) {
  heldUploads.length = 0;
  const handler = new RPCHandler({
    recording: createCandidateRecordingRouter(fixture),
  });

  await page.route("**/api/rpc**", async (route) => {
    const browserRequest = route.request();
    const request = new Request(browserRequest.url(), {
      body: ["GET", "HEAD"].includes(browserRequest.method())
        ? undefined
        : (() => {
            const body = browserRequest.postDataBuffer();
            return body ? new Uint8Array(body) : undefined;
          })(),
      headers: browserRequest.headers(),
      method: browserRequest.method(),
    });
    const result = await handler.handle(request, {
      context: {},
      prefix: "/api/rpc",
    });
    const response =
      result.response ?? new Response("Not found", { status: 404 });
    await route.fulfill({
      body: await response.text(),
      headers: Object.fromEntries(response.headers),
      status: response.status,
    });
  });

  await page.route("**/api/recordings/**/parts/**", (route) => {
    if (route.request().method() === "OPTIONS") {
      return route.fulfill({
        body: "",
        headers: {
          "Access-Control-Allow-Headers": "*",
          "Access-Control-Allow-Methods": "PUT, OPTIONS",
          "Access-Control-Allow-Origin": "*",
        },
        status: 204,
      });
    }
    let mode = upload?.mode;
    if (!mode) {
      if (uploadStatus >= 500) {
        mode = "retryable";
      } else if (uploadStatus >= 400) {
        mode = "fatal";
      } else {
        mode = "success";
      }
    }
    if (mode === "offline") {
      heldUploads.push(route);
      return;
    }
    if (mode === "retryable") {
      return route.fulfill({ status: 503 });
    }
    if (mode === "fatal") {
      return route.fulfill({
        status: uploadStatus >= 400 ? uploadStatus : 409,
      });
    }
    recordUploadedPart(fixture);
    return route.fulfill({ body: "", status: 201 });
  });

  await page.route("**/api/recordings/**/submission", (route) => {
    if (route.request().method() === "GET") {
      return route.fulfill({
        body: recoveredSubmission,
        contentType: "video/webm",
        status: 200,
      });
    }
    return route.fulfill({ status: 405 });
  });
}

export interface RecordingFixtureOptions {
  finalization?: "failed" | "pending" | "ready";
  storage?: {
    persistResult?: boolean;
    persisted?: boolean;
    probeFails?: boolean;
    quota?: number;
    usage?: number;
    writeFailsAfterPart?: number;
  };
  upload?: {
    mode?: "fatal" | "offline" | "retryable" | "success";
  };
}

type UploadMode = NonNullable<
  NonNullable<RecordingFixtureOptions["upload"]>["mode"]
>;

const heldUploads: Array<{ abort: (errorCode?: string) => Promise<void> }> = [];

const PREFLIGHT_PROBE_KEY = "__recording_preflight_probe__";

export async function installRecordingStorage(
  page: Page,
  storage: RecordingFixtureOptions["storage"] = {}
) {
  await page.addInitScript(
    ({
      persistResult,
      persisted,
      probeFails,
      probeKey,
      quota,
      usage,
      writeFailsAfterPart,
    }) => {
      const estimate = {
        quota: quota ?? 1_000_000_000,
        usage: usage ?? 10,
      };
      window.__recordingTestStorage = estimate;
      const storageMock = {
        estimate: async () => window.__recordingTestStorage ?? estimate,
        persist: async () => persistResult ?? true,
        persisted: async () => persisted ?? true,
      };
      const existing = navigator.storage as StorageManager | undefined;
      if (existing) {
        existing.estimate = storageMock.estimate;
        existing.persist = storageMock.persist;
        existing.persisted = storageMock.persisted;
      }
      Object.defineProperty(navigator, "storage", {
        configurable: true,
        value: existing ?? storageMock,
      });

      if (probeFails || writeFailsAfterPart !== undefined) {
        const store = IDBObjectStore.prototype;
        const originalPut = store.put;
        let successfulPartWrites = 0;
        store.put = function putWithFixture(value: unknown) {
          const record = value as {
            id?: string;
            sequence?: number;
            sessionId?: string;
          };
          if (probeFails && record.id === probeKey) {
            throw new Error("probe failed");
          }
          if (
            writeFailsAfterPart !== undefined &&
            record.sessionId &&
            typeof record.sequence === "number" &&
            record.id !== probeKey
          ) {
            if (successfulPartWrites >= writeFailsAfterPart) {
              throw new Error("IndexedDB write failed");
            }
            successfulPartWrites += 1;
          }
          return originalPut.call(this, value);
        };
      }
    },
    {
      persisted: storage.persisted ?? true,
      persistResult: storage.persistResult ?? true,
      probeFails: storage.probeFails ?? false,
      probeKey: PREFLIGHT_PROBE_KEY,
      quota: storage.quota ?? 1_000_000_000,
      usage: storage.usage ?? 10,
      writeFailsAfterPart: storage.writeFailsAfterPart,
    }
  );
}

export function createUploadController(initial: UploadMode = "success") {
  let mode = initial;
  return {
    get mode() {
      return mode;
    },
    setMode(next: UploadMode) {
      mode = next;
    },
  };
}

export async function installRecordingFixture(
  page: Page,
  options: RecordingFixtureOptions = {}
) {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
    }
  });
  await installRecordingStorage(page, options.storage);
  await installMediaRecorder(page);
  const fixture = createCandidateBindings();
  if (options.finalization === "failed") {
    fixture.bindings.finalizeRecording = () =>
      Promise.reject(new Error("finalization unavailable"));
  } else if (options.finalization === "ready") {
    const finalize = fixture.bindings.finalizeRecording;
    fixture.bindings.finalizeRecording = async (input) => {
      await finalize(input);
      fixture.markAllReady();
      return { status: "ready" };
    };
  }
  const upload = createUploadController(options.upload?.mode ?? "success");
  let uploadStatus = 204;
  if (options.upload?.mode === "fatal") {
    uploadStatus = 409;
  } else if (options.upload?.mode === "retryable") {
    uploadStatus = 503;
  }
  await installRecordingApi(page, fixture, uploadStatus, upload);
  return { fixture, upload };
}

export async function reconnectRecordingFixture(
  page: Page,
  upload?: { setMode: (mode: UploadMode) => void }
) {
  upload?.setMode("success");
  await Promise.all(
    heldUploads.splice(0).map((route) => route.abort("internetdisconnected"))
  );
  await page.evaluate(() => {
    window.dispatchEvent(new Event("online"));
  });
}

export async function installMediaRecorder(page: Page) {
  await page.addInitScript(() => {
    window.__recordingTestState = { stoppedTracks: 0 };

    class TestTrack {
      private stops = 0;
      readonly kind = "video";
      readonly id = crypto.randomUUID();

      stop() {
        this.stops += 1;
        if (this.stops === 1) {
          window.__recordingTestState.stoppedTracks += 1;
        }
      }
    }

    const tracks = [new TestTrack(), new TestTrack()];
    navigator.mediaDevices.getUserMedia = async () =>
      ({ getTracks: () => tracks }) as unknown as MediaStream;

    class TestMediaRecorder extends EventTarget {
      static isTypeSupported() {
        return true;
      }
      audioBitsPerSecond = 128_000;
      mimeType = "video/webm;codecs=opus";
      state: RecordingState = "inactive";
      videoBitsPerSecond = 1_000_000;
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;

      emitPart(value = "candidate recording") {
        const event = new BlobEvent("dataavailable", {
          data: new Blob([value], { type: this.mimeType }),
        });
        this.ondataavailable?.(event);
        this.dispatchEvent(event);
      }

      start() {
        this.state = "recording";
        window.__testMediaRecorder = this;
      }

      stop() {
        if (this.state === "inactive") {
          return;
        }
        this.state = "inactive";
        setTimeout(() => {
          const event = new BlobEvent("dataavailable", {
            data: new Blob(["candidate recording"], { type: this.mimeType }),
          });
          this.ondataavailable?.(event);
          this.dispatchEvent(event);
          this.onstop?.();
          this.dispatchEvent(new Event("stop"));
        }, 0);
      }
    }

    window.MediaRecorder = TestMediaRecorder as unknown as typeof MediaRecorder;
  });
}
