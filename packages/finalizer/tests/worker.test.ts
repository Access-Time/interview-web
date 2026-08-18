import { Effect } from "effect";
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

import { getContainer } from "@cloudflare/containers";
import { listRecordingsForFinalization } from "@interview-web/db";
import { dispatchFinalization } from "../src/worker/dispatch.ts";
import { makeFinalizationQueue } from "../src/worker/queue.ts";
import worker, {
  type FinalizerEnv,
  getFinalizerContainer,
  isExactFinalizerOutput,
  isExactPublishedObject,
  normalizeSha256Checksum,
  outputMediaType,
  reconciliationBatch,
  validateFinalizePlan,
  validateManifest,
} from "../src/worker.ts";

const dispatchRequest = (body = JSON.stringify({ sessionId: "session-1" })) =>
  new Request("https://finalizer/internal/finalizations", {
    body,
    headers: { "content-type": "application/json" },
    method: "POST",
  });

describe("dispatchFinalization", () => {
  it("queues one valid internal dispatch", async () => {
    const send = vi.fn().mockResolvedValue(undefined);

    const response = await Effect.runPromise(
      dispatchFinalization(dispatchRequest()).pipe(
        Effect.provide(makeFinalizationQueue({ send } as never))
      )
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

    const response = await Effect.runPromise(
      dispatchFinalization(request).pipe(
        Effect.provide(makeFinalizationQueue({ send } as never))
      )
    );

    expect(response.status).toBe(status);
    expect(send).not.toHaveBeenCalled();
  });

  it("returns 503 when queueing fails", async () => {
    const send = vi.fn().mockRejectedValue(new Error("queue down"));

    const response = await Effect.runPromise(
      dispatchFinalization(dispatchRequest()).pipe(
        Effect.provide(makeFinalizationQueue({ send } as never))
      )
    );

    expect(response.status).toBe(503);
  });
});

it("scheduled reconciliation enqueues every mapped session in order", async () => {
  const sessions = ["session-1", "session-2", "session-3"];
  const send = vi.fn().mockResolvedValue(undefined);
  const env = {
    DB: {},
    FINALIZATION_QUEUE: { send },
  } as unknown as FinalizerEnv;
  vi.mocked(listRecordingsForFinalization).mockResolvedValue(sessions);

  expect(await reconciliationBatch({} as never)).toEqual(
    sessions.map((sessionId) => ({ sessionId }))
  );

  await worker.scheduled({} as ScheduledEvent, env);

  expect(send).toHaveBeenCalledTimes(sessions.length);
  expect(send.mock.calls.map(([message]) => message)).toEqual(
    sessions.map((sessionId) => ({ sessionId }))
  );
});

it("reuses one finalizer container instead of naming one per attempt", () => {
  const namespace = {
    idFromName: vi.fn(),
  } as unknown as NonNullable<FinalizerEnv["FINALIZER"]>;
  const stub = { fetch: vi.fn() };
  vi.mocked(getContainer).mockReturnValue(stub as never);

  expect(getFinalizerContainer({ FINALIZER: namespace })).toBe(stub);
  expect(getContainer).toHaveBeenCalledExactlyOnceWith(namespace);
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
  const segment = base.segments.find(() => true);
  const part = segment?.parts.find(() => true);
  if (!(segment && part)) {
    throw new Error("expected segment part");
  }
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

const digestHex = async (bytes: Uint8Array) =>
  [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");

it("published object matching accepts hex-string and binary R2 checksums", async () => {
  const bytes = new Uint8Array([9, 8, 7, 6]);
  const checksum = await digestHex(bytes);
  const expected = {
    checksum,
    mediaType: "video/webm",
    size: bytes.byteLength,
  };
  expect(
    isExactPublishedObject(
      {
        checksums: { sha256: checksum },
        httpMetadata: { contentType: "video/webm" },
        size: bytes.byteLength,
      },
      expected
    )
  ).toBe(true);
  expect(
    isExactPublishedObject(
      {
        checksums: { sha256: await crypto.subtle.digest("SHA-256", bytes) },
        httpMetadata: { contentType: "video/webm" },
        size: bytes.byteLength,
      },
      expected
    )
  ).toBe(true);
  expect(normalizeSha256Checksum(checksum.toUpperCase())).toBe(checksum);
  expect(
    isExactPublishedObject(
      {
        checksums: { sha256: checksum },
        httpMetadata: { contentType: "video/webm" },
        size: bytes.byteLength + 1,
      },
      expected
    )
  ).toBe(false);
});
