import type {
  AppendRecordingSegmentInput,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingManifest,
  RecordingStatus,
} from "@interview-web/db";
import { ORPCError, os } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { Page } from "@playwright/test";
import z from "zod";

declare global {
  interface Window {
    __recordingTestState: { stoppedTracks: number };
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
  createRecordingSession: (
    input: AppendRecordingSegmentInput
  ) => Promise<unknown>;
  getRecordingManifest: (
    sessionId: string
  ) => Promise<RecordingManifest | null>;
  getRecordingStatus: (sessionId: string) => Promise<RecordingStatus | null>;
  markAllReady: () => void;
}

export function createCandidateBindings(): CandidateBindingFixture {
  const manifests = new Map<string, RecordingManifest>();
  const statuses = new Map<string, RecordingStatus>();
  const appendedSegments = new Map<string, AppendRecordingSegmentInput[]>();

  return {
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
        statuses.set(input.sessionId, { status: "queued" });
        return Promise.resolve({ status: "queued" });
      },
    },
    createRecordingSession: (input) => {
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
    getRecordingManifest: (sessionId) =>
      Promise.resolve(manifests.get(sessionId) ?? null),
    getRecordingStatus: (sessionId) =>
      Promise.resolve(statuses.get(sessionId) ?? null),
    markAllReady: () => {
      for (const sessionId of statuses.keys()) {
        statuses.set(sessionId, { status: "ready" });
      }
    },
  };
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
  uploadStatus = 204
) {
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

  await page.route("**/api/recordings/**/parts/**", (route) =>
    route.fulfill({ status: uploadStatus })
  );
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
      mimeType = "video/webm;codecs=opus";
      state: RecordingState = "inactive";
      ondataavailable: ((event: BlobEvent) => void) | null = null;
      onerror: ((event: Event) => void) | null = null;
      onstop: (() => void) | null = null;

      start() {
        this.state = "recording";
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
