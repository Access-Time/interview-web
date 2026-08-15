import { createContext } from "@interview-web/api/context";
import { dispatchFinalization } from "@interview-web/api/finalizer";
import { recordingRouter } from "@interview-web/api/routers/recording";
import {
  appendRecordingSegment,
  createRecordingSession,
  type Database,
  finalizeRecording,
  getRecordingManifest,
  getRecordingPlaybackSummary,
  getRecordingStatus,
  listRecordingPlaybackSummaries,
  type RecordingPlaybackCursor,
  type RecordingPlaybackPage,
  type RecordingPlaybackSummary,
} from "@interview-web/db";
import { createORPCClient } from "@orpc/client";
import { RPCLink } from "@orpc/client/fetch";
import { RPCHandler } from "@orpc/server/fetch";
import { beforeEach, expect, it, vi } from "vitest";

const { finalizerFetch } = vi.hoisted(() => ({
  finalizerFetch: vi.fn<(request: Request) => Promise<Response>>(),
}));

vi.mock("@interview-web/env/server", () => ({
  env: { FINALIZER: { fetch: finalizerFetch } },
}));

vi.mock("@interview-web/db", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@interview-web/db")>();
  return {
    ...actual,
    appendRecordingSegment: vi.fn(),
    createDb: vi.fn(() => ({}) as Database),
    createRecordingSession: vi.fn(),
    finalizeRecording: vi.fn(),
    getRecordingManifest: vi.fn(),
    getRecordingPlaybackSummary: vi.fn(),
    getRecordingStatus: vi.fn(),
    listRecordingPlaybackSummaries: vi.fn(),
  };
});

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
const db = {} as Database;

interface RecordingClient {
  recording: {
    appendSegment: (value: typeof input) => Promise<unknown>;
    create: (value: typeof input) => Promise<unknown>;
    getManifest: (value: { sessionId: string }) => Promise<typeof manifest>;
    getPlaybackSummary: (value: {
      sessionId: string;
    }) => Promise<RecordingPlaybackSummary>;
    finalize: (value: {
      sessionId: string;
      segments: Array<{ segmentId: string; partCount: number }>;
    }) => Promise<unknown>;
    getStatus: (value: { sessionId: string }) => Promise<unknown>;
    listPlaybackSummaries: (value: {
      cursor?: RecordingPlaybackCursor;
    }) => Promise<RecordingPlaybackPage>;
  };
}

function createClient() {
  const handler = new RPCHandler({ recording: recordingRouter });
  return createORPCClient(
    new RPCLink({
      fetch: (request, init) => {
        const adaptedRequest = new Request(new Request(request, init));
        return handler
          .handle(adaptedRequest, {
            context: createContext(),
            prefix: "/rpc",
          })
          .then(
            (result) => result.response ?? new Response(null, { status: 404 })
          );
      },
      url: "https://example.test/rpc",
    })
  ) as unknown as RecordingClient;
}

beforeEach(() => {
  vi.clearAllMocks();
  finalizerFetch.mockResolvedValue(new Response(null, { status: 202 }));
  vi.mocked(appendRecordingSegment).mockImplementation(async (_db, value) => ({
    index: 1,
    recorderMimeType: value.recorderMimeType ?? null,
    requestedMimeType: value.requestedMimeType ?? null,
    segmentId: value.segmentId,
    sessionId: value.sessionId,
  }));
  vi.mocked(createRecordingSession).mockImplementation(async (_db, value) => ({
    recorderMimeType: value.recorderMimeType ?? null,
    requestedMimeType: value.requestedMimeType ?? null,
    segmentId: value.segmentId,
    sessionId: value.sessionId,
  }));
  vi.mocked(finalizeRecording).mockResolvedValue({ status: "queued" });
  vi.mocked(getRecordingManifest).mockResolvedValue(manifest);
  vi.mocked(getRecordingPlaybackSummary).mockResolvedValue(playbackSummary);
  vi.mocked(getRecordingStatus).mockResolvedValue({ status: "queued" });
  vi.mocked(listRecordingPlaybackSummaries).mockResolvedValue(playbackPage);
});

it("recording.appendSegment is public and returns the appended segment", async () => {
  const client = createClient();
  expect(await client.recording.appendSegment(input)).toEqual({
    ...input,
    index: 1,
  });
  expect(appendRecordingSegment).toHaveBeenCalledWith(db, input);
});

it("recording.appendSegment maps conflicts and rejects invalid input", async () => {
  const client = createClient();
  vi.mocked(appendRecordingSegment).mockImplementation(() => {
    const error = new Error("conflict");
    error.name = "AppendRecordingSegmentConflictError";
    return Promise.reject(error);
  });
  await expect(() =>
    client.recording.appendSegment(input)
  ).rejects.toMatchObject({
    code: "SEGMENT_CONFLICT",
    status: 409,
  });
  await expect(() =>
    client.recording.appendSegment({ ...input, sessionId: "" })
  ).rejects.toMatchObject({ status: 400 });
});

it("recording.finalize and recording.getStatus are public", async () => {
  const client = createClient();
  expect(
    await client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    })
  ).toEqual({ status: "queued" });
  expect(
    await client.recording.getStatus({ sessionId: input.sessionId })
  ).toEqual({ status: "queued" });
});

it("recording.finalize enqueues once after persistence", async () => {
  const events: string[] = [];
  const client = createClient();
  vi.mocked(finalizeRecording).mockImplementation(() => {
    events.push("persist");
    return Promise.resolve({ status: "queued" as const });
  });
  finalizerFetch.mockImplementation(async (request) => {
    const body = (await request.clone().json()) as { sessionId: string };
    events.push(`enqueue:${body.sessionId}`);
    return new Response(null, { status: 202 });
  });

  await client.recording.finalize({
    segments: [{ partCount: 1, segmentId: input.segmentId }],
    sessionId: input.sessionId,
  });

  expect(finalizerFetch).toHaveBeenCalledTimes(1);
  expect(events).toEqual(["persist", `enqueue:${input.sessionId}`]);
});

it("recording.finalize forwards every status result", async () => {
  const client = createClient();
  for (const status of ["queued", "finalizing", "ready", "failed"] as const) {
    vi.mocked(finalizeRecording).mockResolvedValueOnce({ status });
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
  const client = createClient();
  for (const status of ["finalizing", "ready", "failed"] as const) {
    vi.mocked(finalizeRecording).mockResolvedValueOnce({ status });
    // biome-ignore lint/performance/noAwaitInLoops: statuses are asserted in order.
    await client.recording.finalize({
      segments: [{ partCount: 1, segmentId: input.segmentId }],
      sessionId: input.sessionId,
    });
    expect(finalizerFetch).not.toHaveBeenCalled();
  }
});

it("recording.finalize acknowledges queued persistence when enqueue fails", async () => {
  let persisted = false;
  const client = createClient();
  const error = new Error("queue unavailable");
  const consoleError = vi
    .spyOn(console, "error")
    .mockImplementation(() => undefined);
  vi.mocked(finalizeRecording).mockImplementation(() => {
    persisted = true;
    return Promise.resolve({ status: "queued" as const });
  });
  finalizerFetch.mockRejectedValue(error);

  try {
    await expect(
      client.recording.finalize({
        segments: [{ partCount: 1, segmentId: input.segmentId }],
        sessionId: input.sessionId,
      })
    ).resolves.toEqual({ status: "queued" });
    expect(persisted).toBe(true);
    expect(finalizerFetch).toHaveBeenCalledTimes(1);
    expect(new URL(finalizerFetch.mock.calls[0]?.[0].url).pathname).toBe(
      "/internal/finalizations"
    );
    expect(await finalizerFetch.mock.calls[0]?.[0].json()).toEqual({
      sessionId: input.sessionId,
    });
    expect(consoleError).toHaveBeenCalledWith(
      "Recording finalization dispatch failed",
      { error, sessionId: input.sessionId }
    );
  } finally {
    consoleError.mockRestore();
  }
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
  ["not found", "RecordingNotFoundError", 404, "RECORDING_NOT_FOUND"],
  ["conflicts", "RecordingFinalizeConflictError", 409, "FINALIZE_CONFLICT"],
] as const) {
  it(`recording.finalize maps ${name}`, async () => {
    const client = createClient();
    vi.mocked(finalizeRecording).mockImplementation(() => {
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
  const client = createClient();
  vi.mocked(finalizeRecording).mockRejectedValue(
    new Error("must not be called")
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
  expect(finalizeRecording).not.toHaveBeenCalled();
});

it("recording.create is public and calls the session service", async () => {
  const client = createClient();
  expect(await client.recording.create(input)).toEqual(input);
  expect(createRecordingSession).toHaveBeenCalledTimes(1);
});

it("recording.create forwards and returns MIME metadata", async () => {
  const client = createClient();
  expect(await client.recording.create(input)).toEqual(input);
  expect(createRecordingSession).toHaveBeenCalledWith(db, input);
});

it("recording.create maps session conflicts to SESSION_CONFLICT", async () => {
  const client = createClient();
  vi.mocked(createRecordingSession).mockImplementation(() => {
    const error = new Error("conflict");
    error.name = "CreateRecordingSessionConflictError";
    throw error;
  });
  await expect(client.recording.create(input)).rejects.toMatchObject({
    code: "SESSION_CONFLICT",
    status: 409,
  });
});

it("recording.getManifest is public and returns the manifest", async () => {
  const client = createClient();
  expect(
    await client.recording.getManifest({
      sessionId: input.sessionId,
    })
  ).toEqual(manifest);
});

it("missing manifest maps to RECORDING_NOT_FOUND", async () => {
  const client = createClient();
  vi.mocked(getRecordingManifest).mockResolvedValue(null);
  await expect(
    client.recording.getManifest({
      sessionId: "missing",
    })
  ).rejects.toMatchObject({ code: "RECORDING_NOT_FOUND", status: 404 });
});

it("recording.listPlaybackSummaries forwards its cursor and returns only playback fields", async () => {
  const cursor = { createdAt: 1_724_999_999_999, id: "session-0" };
  const received: Array<{ cursor?: RecordingPlaybackCursor }> = [];
  const client = createClient();
  vi.mocked(listRecordingPlaybackSummaries).mockImplementation((_db, value) => {
    received.push(value);
    return Promise.resolve(playbackPage);
  });

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

it("recording.getPlaybackSummary maps a missing summary to RECORDING_NOT_FOUND", async () => {
  const client = createClient();
  vi.mocked(getRecordingPlaybackSummary).mockResolvedValue(null);

  await expect(
    client.recording.getPlaybackSummary({ sessionId: "missing" })
  ).rejects.toMatchObject({ code: "RECORDING_NOT_FOUND", status: 404 });
});

it("recording playback procedures reject invalid input before calling services", async () => {
  const client = createClient();

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

  expect(getRecordingPlaybackSummary).not.toHaveBeenCalled();
  expect(listRecordingPlaybackSummaries).not.toHaveBeenCalled();
});
