import assert from "node:assert/strict";
import test from "node:test";
import {
  createContext,
  type RecordingBindings,
} from "@interview-web/api/context";
import { recordingRouter } from "@interview-web/api/routers/recording";
import type { CreateRecordingSessionResult } from "@interview-web/db";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";

const input = {
  recorderMimeType: "video/webm;codecs=opus",
  requestedMimeType: "video/webm",
  segmentId: "segment-1",
  sessionId: "session-1",
};
const manifest = {
  createdAt: 1,
  segments: [],
  sessionId: input.sessionId,
};
interface RecordingClient {
  recording: {
    create: (value: typeof input) => Promise<CreateRecordingSessionResult>;
    getManifest: (value: { sessionId: string }) => Promise<typeof manifest>;
  };
}

function setup(
  getManifest: RecordingBindings["getRecordingManifest"] = async () => manifest,
  createRecordingSession: RecordingBindings["createRecordingSession"] = async (
    value
  ) => ({
    recorderMimeType: value.recorderMimeType ?? null,
    requestedMimeType: value.requestedMimeType ?? null,
    segmentId: value.segmentId,
    sessionId: value.sessionId,
  })
) {
  const createCalls: unknown[] = [];
  const bindings: RecordingBindings = {
    createRecordingSession: (value) => {
      createCalls.push(value);
      return createRecordingSession(value);
    },
    getRecordingManifest: getManifest,
  };
  const handler = new RPCHandler({ recording: recordingRouter });
  const client = createORPCClient(
    new RPCLink({
      fetch: (request, init) => {
        const originalRequest = new Request(request, init);
        const adaptedRequest = new Request(originalRequest);
        return handler
          .handle(adaptedRequest, {
            context: createContext({
              bindings,
            }),
            prefix: "/rpc",
          })
          .then(
            (result) => result.response ?? new Response(null, { status: 404 })
          );
      },
      url: "https://example.test/rpc",
    })
  ) as unknown as RecordingClient;
  return {
    client,
    createCalls,
  };
}

test("recording.create is public and calls the injected helper", async () => {
  const { client, createCalls } = setup();
  assert.deepEqual(await client.recording.create(input), input);
  assert.equal(createCalls.length, 1);
});

test("recording.create forwards and returns MIME metadata", async () => {
  const { client, createCalls } = setup();
  assert.deepEqual(await client.recording.create(input), input);
  assert.deepEqual(createCalls, [input]);
});

test("recording.create maps session conflicts to Conflict", async () => {
  const setupResult = setup(undefined, () => {
    const error = new Error("conflict");
    error.name = "CreateRecordingSessionConflictError";
    throw error;
  });
  await assert.rejects(
    () => setupResult.client.recording.create(input),
    (error: unknown) => {
      assert.equal(
        error && typeof error === "object" && "status" in error
          ? error.status
          : undefined,
        409
      );
      assert.equal(
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined,
        "CONFLICT"
      );
      return true;
    }
  );
});

test("recording.getManifest is public and returns the manifest", async () => {
  const setupResult = setup();
  assert.deepEqual(
    await setupResult.client.recording.getManifest({
      sessionId: input.sessionId,
    }),
    manifest
  );
});

test("missing manifest maps to Not Found", async () => {
  const setupResult = setup(async () => null);
  await assert.rejects(
    () =>
      setupResult.client.recording.getManifest({
        sessionId: "missing",
      }),
    (error: unknown) => {
      assert.equal(
        error && typeof error === "object" && "status" in error
          ? error.status
          : undefined,
        404
      );
      assert.equal(
        error && typeof error === "object" && "code" in error
          ? error.code
          : undefined,
        "NOT_FOUND"
      );
      return true;
    }
  );
});
