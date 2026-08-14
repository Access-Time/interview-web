import {
  createContext,
  type RecordingBindings,
} from "@interview-web/api/context";
import { recordingRouter } from "@interview-web/api/routers/recording";
import type {
  AppendRecordingSegmentResult,
  CreateRecordingSessionResult,
  RecordingFinalizeResult,
  RecordingPlaybackCursor,
  RecordingPlaybackPage,
  RecordingPlaybackSummary,
  RecordingStatus,
} from "@interview-web/db";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { expect, it, vi } from "vitest";
import { dispatchFinalization } from "@/routes/api/rpc/$";

vi.mock("@interview-web/env/server", () => ({ env: {} }));

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
const playbackSummary: RecordingPlaybackSummary = {
  createdAt: 1_725_000_000_000,
  hasOutput: true,
  id: "session-1",
  outputByteSize: 1024,
  outputMediaType: "video/webm",
  status: "ready",
};
const playbackPage: RecordingPlaybackPage = {
  items: [playbackSummary],
  nextCursor: null,
};
interface RecordingClient {
  recording: {
    appendSegment: (
      value: typeof input
    ) => Promise<AppendRecordingSegmentResult>;
    create: (value: typeof input) => Promise<CreateRecordingSessionResult>;
    getManifest: (value: { sessionId: string }) => Promise<typeof manifest>;
    getPlaybackSummary: (value: {
      sessionId: string;
    }) => Promise<RecordingPlaybackSummary>;
    finalize: (value: {
      sessionId: string;
      segments: Array<{ segmentId: string; partCount: number }>;
    }) => Promise<RecordingFinalizeResult>;
    getStatus: (value: { sessionId: string }) => Promise<RecordingStatus>;
    listPlaybackSummaries: (value: {
      cursor?: RecordingPlaybackCursor;
    }) => Promise<RecordingPlaybackPage>;
  };
}
type PlaybackBindingOverrides = Partial<
  Pick<
    RecordingBindings,
    "getRecordingPlaybackSummary" | "listRecordingPlaybackSummaries"
  >
>;

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
  }),
  playbackBindings: PlaybackBindingOverrides = {}
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
    getRecordingPlaybackSummary:
      playbackBindings.getRecordingPlaybackSummary ??
      (async () => playbackSummary),
    getRecordingStatus,
    listRecordingPlaybackSummaries:
      playbackBindings.listRecordingPlaybackSummaries ??
      (async () => playbackPage),
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

it("recording.appendSegment is public and returns the appended segment", async () => {
  const { client } = setup();
  expect(await client.recording.appendSegment(input)).toEqual({
    ...input,
    index: 1,
  });
});

it("recording.appendSegment maps conflicts and rejects invalid input", async () => {
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
  await expect(() =>
    client.recording.appendSegment(input)
  ).rejects.toMatchObject({
    code: "CONFLICT",
    status: 409,
  });
  await expect(() =>
    client.recording.appendSegment({ ...input, sessionId: "" })
  ).rejects.toMatchObject({ status: 400 });
});

it("recording.finalize and recording.getStatus are public", async () => {
  const result = setup();
  expect(
    await result.client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    })
  ).toEqual({ status: "queued" });
  expect(
    await result.client.recording.getStatus({ sessionId: input.sessionId })
  ).toEqual({ status: "queued" });
});

it("recording.finalize enqueues once after persistence", async () => {
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
  expect(enqueueCalls).toEqual([{ sessionId: input.sessionId }]);
  expect(events).toEqual(["persist", `enqueue:${input.sessionId}`]);
});

it("recording.finalize forwards every status result", async () => {
  for (const status of ["queued", "finalizing", "ready", "failed"] as const) {
    const { client } = setup(undefined, undefined, async () => ({ status }));
    expect(
      // biome-ignore lint/performance/noAwaitInLoops: statuses are asserted in order.
      await client.recording.finalize({
        segments: [{ partCount: 1, segmentId: input.segmentId }],
        sessionId: input.sessionId,
      })
    ).toEqual({ status });
  }
});

it("recording.finalize does not enqueue non-queued results", async () => {
  for (const status of ["finalizing", "ready", "failed"] as const) {
    const { client, enqueueCalls } = setup(undefined, undefined, async () => ({
      status,
    }));
    // biome-ignore lint/performance/noAwaitInLoops: statuses are asserted in order.
    await client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    });
    expect(enqueueCalls).toEqual([]);
  }
});

it("recording.finalize rejects when enqueue fails after persistence", async () => {
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
  await expect(
    client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    })
  ).rejects.toThrow();
  expect(persisted).toBe(true);
  expect(enqueueCalls).toEqual([{ sessionId: input.sessionId }]);
});

it("dispatchFinalization sends the session through the private binding", async () => {
  const fetch = vi.fn<(request: Request) => Promise<Response>>();
  fetch.mockResolvedValue(new Response(null, { status: 202 }));

  await dispatchFinalization({ fetch }, "session-1");

  expect(fetch).toHaveBeenCalledTimes(1);
  const request = fetch.mock.calls[0]?.[0];
  if (!(request instanceof Request)) {
    throw new Error("Finalizer dispatch did not receive a Request");
  }
  expect(request.method).toBe("POST");
  expect(new URL(request.url).pathname).toBe("/internal/finalizations");
  expect(request.headers.get("content-type")).toBe("application/json");
  expect(await request.json()).toEqual({ sessionId: "session-1" });
});

it("dispatchFinalization rejects a failed private binding response", async () => {
  const fetch = vi.fn<(request: Request) => Promise<Response>>();
  fetch.mockResolvedValue(new Response(null, { status: 503 }));

  await expect(dispatchFinalization({ fetch }, "session-1")).rejects.toThrow(
    "Finalization dispatch failed"
  );
});

for (const [name, errorName, status, code] of [
  ["not found", "RecordingNotFoundError", 404, "NOT_FOUND"],
  ["conflicts", "RecordingFinalizeConflictError", 409, "CONFLICT"],
] as const) {
  it(`recording.finalize maps ${name}`, async () => {
    const { client } = setup(undefined, undefined, () => {
      const error = new Error("database error");
      error.name = errorName;
      return Promise.reject(error);
    });
    await expect(
      client.recording.finalize({
        segments: [{ partCount: 1, segmentId: input.segmentId }],
        sessionId: input.sessionId,
      })
    ).rejects.toMatchObject({ code, status });
  });
}

it("recording.finalize rejects invalid input at the public boundary", async () => {
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
    await expect(() =>
      client.recording.finalize(invalidInput)
    ).rejects.toMatchObject({
      status: 400,
    });
  }
});

it("recording.create is public and calls the injected helper", async () => {
  const { client, createCalls } = setup();
  expect(await client.recording.create(input)).toEqual(input);
  expect(createCalls.length).toBe(1);
});

it("recording.create forwards and returns MIME metadata", async () => {
  const { client, createCalls } = setup();
  expect(await client.recording.create(input)).toEqual(input);
  expect(createCalls).toEqual([input]);
});

it("recording.create maps session conflicts to Conflict", async () => {
  const setupResult = setup(undefined, () => {
    const error = new Error("conflict");
    error.name = "CreateRecordingSessionConflictError";
    throw error;
  });
  await expect(
    setupResult.client.recording.create(input)
  ).rejects.toMatchObject({
    code: "CONFLICT",
    status: 409,
  });
});

it("recording.getManifest is public and returns the manifest", async () => {
  const setupResult = setup();
  expect(
    await setupResult.client.recording.getManifest({
      sessionId: input.sessionId,
    })
  ).toEqual(manifest);
});

it("missing manifest maps to Not Found", async () => {
  const setupResult = setup(async () => null);
  await expect(
    setupResult.client.recording.getManifest({
      sessionId: "missing",
    })
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
});

it("recording.listPlaybackSummaries forwards its cursor and returns only playback fields", async () => {
  const cursor = { createdAt: 1_724_999_999_999, id: "session-0" };
  const received: Array<{ cursor?: RecordingPlaybackCursor }> = [];
  const { client } = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      listRecordingPlaybackSummaries: (value) => {
        received.push(value);
        return Promise.resolve(playbackPage);
      },
    }
  );

  const result = await client.recording.listPlaybackSummaries({ cursor });

  expect(received).toEqual([{ cursor }]);
  expect(result).toEqual(playbackPage);
  expect(result.items[0]).not.toHaveProperty("outputObjectKey");
  expect(result.items[0]).not.toHaveProperty("outputChecksum");
  expect(result.items[0]).not.toHaveProperty("failureCode");
  expect(result.items[0]).not.toHaveProperty("finalizePlan");
  expect(result.items[0]).not.toHaveProperty("leaseExpiresAt");

  received.length = 0;
  await client.recording.listPlaybackSummaries({});
  expect(received).toEqual([{}]);
});

it("recording.getPlaybackSummary maps a missing summary to NOT_FOUND", async () => {
  const { client } = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      getRecordingPlaybackSummary: async () => null,
    }
  );

  await expect(
    client.recording.getPlaybackSummary({ sessionId: "missing" })
  ).rejects.toMatchObject({ code: "NOT_FOUND", status: 404 });
});

it("recording playback procedures reject invalid input before calling bindings", async () => {
  const getPlaybackSummary = vi.fn();
  const listPlaybackSummaries = vi.fn();
  const { client } = setup(
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    undefined,
    {
      getRecordingPlaybackSummary: getPlaybackSummary,
      listRecordingPlaybackSummaries: listPlaybackSummaries,
    }
  );

  await expect(
    client.recording.getPlaybackSummary({ sessionId: "" })
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    client.recording.getPlaybackSummary({ sessionId: "x".repeat(129) })
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    client.recording.listPlaybackSummaries({
      cursor: { createdAt: -1, id: "session-1" },
    })
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    client.recording.listPlaybackSummaries({
      cursor: { createdAt: 1, id: "" },
    })
  ).rejects.toMatchObject({ status: 400 });
  await expect(
    client.recording.listPlaybackSummaries({
      cursor: { createdAt: 1, id: "x".repeat(129) },
    })
  ).rejects.toMatchObject({ status: 400 });

  const invalidCreatedAt: unknown = {
    cursor: { createdAt: 1.25, id: "session-1" },
  };
  await expect(
    client.recording.listPlaybackSummaries(
      invalidCreatedAt as { cursor?: RecordingPlaybackCursor }
    )
  ).rejects.toMatchObject({ status: 400 });

  expect(getPlaybackSummary).not.toHaveBeenCalled();
  expect(listPlaybackSummaries).not.toHaveBeenCalled();
});
