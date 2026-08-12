import assert from "node:assert/strict";
import test from "node:test";
import {
  createContext,
  type RecordingBindings,
} from "@interview-web/api/context";
import { recordingRouter } from "@interview-web/api/routers/recording";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";

const input = { segmentId: "segment-1", sessionId: "session-1" };
const manifest = {
  createdAt: 1,
  segments: [],
  sessionId: input.sessionId,
};
interface RecordingClient {
  recording: {
    create: (value: typeof input) => Promise<typeof input>;
    getManifest: (value: { sessionId: string }) => Promise<typeof manifest>;
  };
}

function setup(
  getManifest: RecordingBindings["getRecordingManifest"] = async () => manifest
) {
  let authorized = false;
  const createCalls: unknown[] = [];
  const bindings: RecordingBindings = {
    createRecordingSession: (value) => {
      createCalls.push(value);
      return Promise.resolve(value);
    },
    getRecordingManifest: getManifest,
    operatorSecret: "test-secret",
  };
  const handler = new RPCHandler({ recording: recordingRouter });
  const client = createORPCClient(
    new RPCLink({
      fetch: (request, init) => {
        const originalRequest = new Request(request, init);
        const headers = new Headers(originalRequest.headers);
        if (authorized) {
          headers.set("Authorization", "Bearer test-secret");
        }
        const adaptedRequest = new Request(originalRequest, { headers });
        return handler
          .handle(adaptedRequest, {
            context: createContext({
              bindings,
              req: adaptedRequest,
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
  const setAuthorized = (value: boolean) => {
    authorized = value;
  };
  return {
    client,
    createCalls,
    setAuthorized,
  };
}

test("unauthorized recording.create is rejected without invoking the helper", async () => {
  const { client, createCalls } = setup();
  await assert.rejects(() => client.recording.create(input));
  assert.equal(createCalls.length, 0);
});

test("authenticated recording.create calls the injected helper", async () => {
  const setupResult = setup();
  setupResult.setAuthorized(true);
  assert.deepEqual(await setupResult.client.recording.create(input), input);
  assert.equal(setupResult.createCalls.length, 1);
});

test("authenticated recording.getManifest returns the manifest", async () => {
  const setupResult = setup();
  setupResult.setAuthorized(true);
  assert.deepEqual(
    await setupResult.client.recording.getManifest({
      sessionId: input.sessionId,
    }),
    manifest
  );
});

test("missing manifest maps to Not Found", async () => {
  const setupResult = setup(async () => null);
  setupResult.setAuthorized(true);
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
