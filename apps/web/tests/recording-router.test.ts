import assert from "node:assert/strict";
import test from "node:test";
import {
  createContext,
  type RecordingBindings,
} from "@interview-web/api/context";
import { recordingRouter } from "@interview-web/api/routers/recording";
import type {
  AppendRecordingSegmentResult,
  CreateRecordingSessionResult,
  RecordingFinalizeResult,
  RecordingStatus,
} from "@interview-web/db";
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
    appendSegment: (
      value: typeof input
    ) => Promise<AppendRecordingSegmentResult>;
    create: (value: typeof input) => Promise<CreateRecordingSessionResult>;
    getManifest: (value: { sessionId: string }) => Promise<typeof manifest>;
    finalize: (value: {
      sessionId: string;
      segments: Array<{ segmentId: string; partCount: number }>;
    }) => Promise<RecordingFinalizeResult>;
    getStatus: (value: { sessionId: string }) => Promise<RecordingStatus>;
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
  }),
  finalizeRecording: RecordingBindings["finalizeRecording"] = async () => ({
    status: "queued",
  }),
  getRecordingStatus: RecordingBindings["getRecordingStatus"] = async () => ({
    status: "queued",
  }),
  enqueueFinalization: RecordingBindings["enqueueFinalization"] = () =>
    Promise.resolve(),
  appendRecordingSegment: RecordingBindings["appendRecordingSegment"] = async (
    value
  ) => ({
    index: 1,
    recorderMimeType: value.recorderMimeType ?? null,
    requestedMimeType: value.requestedMimeType ?? null,
    segmentId: value.segmentId,
    sessionId: value.sessionId,
  })
) {
  const createCalls: unknown[] = [];
  const enqueueCalls: unknown[] = [];
  const bindings: RecordingBindings = {
    appendRecordingSegment,
    createRecordingSession: (value) => {
      createCalls.push(value);
      return createRecordingSession(value);
    },
    enqueueFinalization: (sessionId) => {
      enqueueCalls.push({ sessionId });
      return enqueueFinalization(sessionId);
    },
    finalizeRecording,
    getRecordingManifest: getManifest,
    getRecordingStatus,
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
    enqueueCalls,
  };
}

test("recording.appendSegment is public and returns the appended segment", async () => {
  const { client } = setup();
  assert.deepEqual(await client.recording.appendSegment(input), {
    ...input,
    index: 1,
  });
});

test("recording.appendSegment maps conflicts and rejects invalid input", async () => {
  const { client } = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    () => {
      const error = new Error("conflict");
      error.name = "AppendRecordingSegmentConflictError";
      return Promise.reject(error);
    }
  );
  await assert.rejects(() => client.recording.appendSegment(input), {
    code: "CONFLICT",
    status: 409,
  });
  await assert.rejects(
    () => client.recording.appendSegment({ ...input, sessionId: "" }),
    { status: 400 }
  );
});

test("recording.finalize and recording.getStatus are public", async () => {
  const result = setup();
  assert.deepEqual(
    await result.client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    }),
    { status: "queued" }
  );
  assert.deepEqual(
    await result.client.recording.getStatus({ sessionId: input.sessionId }),
    { status: "queued" }
  );
});

test("recording.finalize enqueues once after persistence", async () => {
  const events: string[] = [];
  const { client, enqueueCalls } = setup(
    undefined,
    undefined,
    () => {
      events.push("persist");
      return Promise.resolve({ status: "queued" as const });
    },
    undefined,
    (sessionId) => {
      events.push(`enqueue:${sessionId}`);
      return Promise.resolve();
    }
  );
  await client.recording.finalize({
    segments: [{ partCount: 1, segmentId: input.segmentId }],
    sessionId: input.sessionId,
  });
  assert.deepEqual(enqueueCalls, [{ sessionId: input.sessionId }]);
  assert.deepEqual(events, ["persist", `enqueue:${input.sessionId}`]);
});

test("recording.finalize forwards every status result", async () => {
  for (const status of ["queued", "finalizing", "ready", "failed"] as const) {
    const { client } = setup(undefined, undefined, async () => ({ status }));
    assert.deepEqual(
      // biome-ignore lint/performance/noAwaitInLoops: statuses are asserted in order.
      await client.recording.finalize({
        segments: [{ partCount: 1, segmentId: input.segmentId }],
        sessionId: input.sessionId,
      }),
      { status }
    );
  }
});

test("recording.finalize does not enqueue non-queued results", async () => {
  for (const status of ["finalizing", "ready", "failed"] as const) {
    const { client, enqueueCalls } = setup(undefined, undefined, async () => ({
      status,
    }));
    // biome-ignore lint/performance/noAwaitInLoops: statuses are asserted in order.
    await client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    });
    assert.deepEqual(enqueueCalls, []);
  }
});

test("recording.finalize returns queued when enqueue fails after persistence", async () => {
  let persisted = false;
  const { client, enqueueCalls } = setup(
    undefined,
    undefined,
    () => {
      persisted = true;
      return Promise.resolve({ status: "queued" as const });
    },
    undefined,
    () => Promise.reject(new Error("queue unavailable"))
  );
  assert.deepEqual(
    await client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    }),
    { status: "queued" }
  );
  assert.equal(persisted, true);
  assert.deepEqual(enqueueCalls, [{ sessionId: input.sessionId }]);
});

for (const [name, errorName, status, code] of [
  ["not found", "RecordingNotFoundError", 404, "NOT_FOUND"],
  ["conflicts", "RecordingFinalizeConflictError", 409, "CONFLICT"],
] as const) {
  test(`recording.finalize maps ${name}`, async () => {
    const { client } = setup(undefined, undefined, () => {
      const error = new Error("database error");
      error.name = errorName;
      return Promise.reject(error);
    });
    await assert.rejects(
      () =>
        client.recording.finalize({
          segments: [{ partCount: 1, segmentId: input.segmentId }],
          sessionId: input.sessionId,
        }),
      (error: unknown) => {
        assert.equal(
          error && typeof error === "object" && "status" in error
            ? error.status
            : undefined,
          status
        );
        assert.equal(
          error && typeof error === "object" && "code" in error
            ? error.code
            : undefined,
          code
        );
        return true;
      }
    );
  });
}

test("recording.finalize rejects invalid input at the public boundary", async () => {
  const { client } = setup(undefined, undefined, () =>
    Promise.reject(new Error("must not be called"))
  );
  const invalidInputs = [
    {
      segments: [{ partCount: 0, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    },
    {
      segments: [{ partCount: -1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    },
    {
      segments: [{ partCount: 1.5, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    },
    {
      segments: [
        { partCount: 1, segmentId: input.segmentId },
        { partCount: 1, segmentId: input.segmentId },
      ],
      sessionId: input.sessionId,
    },
    { segments: [], sessionId: input.sessionId },
    {
      segments: Array.from({ length: 6 }, (_, index) => ({
        partCount: 1,
        segmentId: `segment-${index}`,
      })),
      sessionId: input.sessionId,
    },
    {
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: "x".repeat(129),
    },
    {
      segments: [{ partCount: 1, segmentId: "x".repeat(129) }],
      sessionId: input.sessionId,
    },
  ];
  for (const invalidInput of invalidInputs) {
    // biome-ignore lint/performance/noAwaitInLoops: each invalid input is asserted independently.
    await assert.rejects(() => client.recording.finalize(invalidInput), {
      status: 400,
    });
  }
});

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
