import { describe, expect, it, vi } from "vitest";

vi.mock("@cloudflare/containers", () => ({
  Container: class {},
  getContainer: vi.fn(),
}));

vi.mock("@interview-web/db", () => ({
  claimRecordingFinalization: vi.fn(),
  completeRecordingFinalization: vi.fn(),
  createDb: vi.fn(),
  failRecordingFinalization: vi.fn(),
  getReadyRecordingSubmission: vi.fn(),
  listRecordingsForFinalization: vi.fn(),
  releaseRecordingFinalizationForRetry: vi.fn(),
  renewRecordingFinalizationLease: vi.fn(),
}));

import {
  dispatchFinalizationRequest,
  type FinalizerEnv,
  isExactFinalizerOutput,
  outputMediaType,
  validateFinalizePlan,
  validateManifest,
} from "../src/worker.ts";

const dispatchRequest = (body = JSON.stringify({ sessionId: "session-1" })) =>
  new Request("https://finalizer/internal/finalizations", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

const dispatchEnv = (send: ReturnType<typeof vi.fn>) =>
  ({ FINALIZATION_QUEUE: { send } }) as Pick<
    FinalizerEnv,
    "FINALIZATION_QUEUE"
  >;

describe("dispatchFinalizationRequest", () => {
  it("queues one valid internal dispatch", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    const response = await dispatchFinalizationRequest(
      dispatchRequest(),
      dispatchEnv(send)
    );

    expect(response.status).toBe(202);
    expect(send).toHaveBeenCalledExactlyOnceWith({ sessionId: "session-1" });
  });

  it.each([
    [
      new Request("https://finalizer/internal/finalizations", {
        method: "GET",
      }),
      405,
    ],
    [
      new Request("https://finalizer/not-finalizations", { method: "POST" }),
      404,
    ],
    [dispatchRequest("not-json"), 400],
    [dispatchRequest(JSON.stringify([])), 400],
    [dispatchRequest(JSON.stringify({ sessionId: "" })), 400],
    [dispatchRequest(JSON.stringify({ sessionId: "x".repeat(129) })), 400],
  ])("rejects an invalid dispatch with %i", async (request, status) => {
    const send = vi.fn();

    const response = await dispatchFinalizationRequest(
      request,
      dispatchEnv(send)
    );

    expect(response.status).toBe(status);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 503 when queueing fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue down"));

    const response = await dispatchFinalizationRequest(
      dispatchRequest(),
      dispatchEnv(send)
    );

    expect(response.status).toBe(503);
  });
});

it("manifest validation accepts contiguous bounded parts", () => {
  const manifest = {
    segments: [
      {
        id: "seg",
        index: 0,
        parts: [
          {
            byteSize: 1,
            checksum: "a".repeat(64),
            mediaType: "video/webm",
            objectKey: "p",
            sequence: 0,
          },
        ],
      },
    ],
    sessionId: "s",
  };
  expect(validateManifest(manifest)).toBe(1);
  expect(outputMediaType(manifest)).toBe("video/webm");
  expect(
    validateFinalizePlan(
      manifest,
      JSON.stringify([{ partCount: 1, segmentId: "seg" }])
    )
  ).toEqual([{ partCount: 1, segmentId: "seg" }]);
});

it("manifest validation rejects gaps", () => {
  expect(() =>
    validateManifest({
      segments: [
        {
          id: "seg",
          index: 0,
          parts: [
            {
              byteSize: 1,
              checksum: "a".repeat(64),
              objectKey: "p",
              sequence: 1,
            },
          ],
        },
      ],
      sessionId: "s",
    })
  ).toThrow();
  expect(() =>
    validateFinalizePlan(
      { segments: [{ id: "seg", index: 0, parts: [] }], sessionId: "s" },
      "[]"
    )
  ).toThrow();
});

it("media type defaults safely and exact output matching is strict", () => {
  const base = {
    segments: [
      {
        id: "seg",
        index: 0,
        parts: [
          {
            byteSize: 1,
            checksum: "a".repeat(64),
            objectKey: "p",
            sequence: 0,
          },
        ],
      },
    ],
    sessionId: "s",
  };
  const [segment] = base.segments;
  const [part] = segment.parts;
  expect(outputMediaType(base)).toBe("video/webm");
  expect(
    outputMediaType({
      ...base,
      segments: [
        {
          ...segment,
          parts: [{ ...part, mediaType: "video/webm" }],
          recorderMimeType: "video/mp4",
        },
      ],
    })
  ).toBe("video/webm");
  expect(
    outputMediaType({
      ...base,
      segments: [
        {
          ...segment,
          parts: [{ ...part, mediaType: "video/mp4" }],
          recorderMimeType: "video/mp4",
        },
      ],
    })
  ).toBe("video/mp4");
  const output = {
    byteSize: 1,
    checksum: "a".repeat(64),
    mediaType: "video/webm",
    objectKey: "k",
  };
  expect(isExactFinalizerOutput(output, { ...output })).toBe(true);
  expect(isExactFinalizerOutput(output, { ...output, byteSize: 2 })).toBe(
    false
  );
});
