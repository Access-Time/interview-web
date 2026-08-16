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
import worker, {
  dispatchFinalizationRequest,
  type FinalizerEnv,
  getFinalizerContainer,
  isExactFinalizerOutput,
  isExactPublishedObject,
  normalizeSha256Checksum,
  outputMediaType,
  processFinalization,
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
  } as unknown as FinalizerEnv["FINALIZER"];
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

describe("processFinalization publication", () => {
  const partBytes = new Uint8Array([1, 2, 3, 4]);
  const outputBytes = new Uint8Array([9, 8, 7, 6, 5]);

  const digestPart = () => digestHex(partBytes);
  const digestOutput = () => digestHex(outputBytes);

  const setup = async (recordings: {
    delete?: (key: string) => Promise<void>;
    head?: (key: string) => Promise<{
      checksums?: { sha256?: ArrayBuffer | string };
      httpMetadata?: { contentType?: string };
      size: number;
    } | null>;
    put: (
      key: string,
      value: ReadableStream<Uint8Array> | ArrayBuffer | Uint8Array,
      options: Record<string, unknown>
    ) => Promise<{
      checksums?: { sha256?: ArrayBuffer | string };
      httpMetadata?: { contentType?: string };
      size: number;
    } | null>;
  }) => {
    const partChecksum = await digestPart();
    const outputChecksum = await digestOutput();
    const complete = vi.fn().mockResolvedValue(true);
    const release = vi.fn().mockResolvedValue(true);
    await processFinalization({
      containerForAttempt: () => ({
        fetch: (input, init) => {
          const path = (input instanceof URL ? input : new URL(String(input)))
            .pathname;
          const method = init?.method ?? "GET";
          if (method === "PUT" && path.includes("/parts/")) {
            return new Response(null, { status: 201 });
          }
          if (method === "POST" && path.endsWith("/finalize")) {
            return Response.json({ finalized: true });
          }
          if (method === "GET" && path.endsWith("/output")) {
            return new Response(outputBytes, {
              headers: {
                "content-length": String(outputBytes.byteLength),
                "content-type": "video/webm",
                "x-content-sha256": outputChecksum,
              },
            });
          }
          if (method === "DELETE") {
            return new Response(null, { status: 204 });
          }
          return new Response(null, { status: 404 });
        },
      }),
      db: {} as never,
      dbFns: {
        claim: async () => ({
          attempt: 1,
          finalizePlan: JSON.stringify([{ partCount: 1, segmentId: "seg" }]),
          manifest: {
            segments: [
              {
                id: "seg",
                index: 0,
                parts: [
                  {
                    byteSize: partBytes.byteLength,
                    checksum: partChecksum,
                    mediaType: "video/webm",
                    objectKey: "part-0",
                    sequence: 0,
                  },
                ],
              },
            ],
            sessionId: "s1",
          },
        }),
        complete,
        fail: vi.fn(),
        ready: vi.fn().mockResolvedValue(null),
        release,
        renew: vi.fn().mockResolvedValue(true),
      },
      heartbeatMs: 60_000,
      recordings: {
        delete: recordings.delete ?? (async () => undefined),
        get: async () => ({
          body: new Blob([partBytes]).stream(),
          checksums: {
            sha256: await crypto.subtle.digest("SHA-256", partBytes),
          },
          size: partBytes.byteLength,
        }),
        head: recordings.head ?? (async () => null),
        put: recordings.put,
      },
      sessionId: "s1",
    });
    return { complete, outputChecksum, release };
  };

  it("buffers container output so R2 put does not need the live stream", async () => {
    const puts: unknown[] = [];
    const { complete, outputChecksum } = await setup({
      put: async (_key, value) => {
        puts.push(value);
        if (value instanceof ReadableStream) {
          throw new Error("ReadableStream cannot be piped to local R2");
        }
        return {
          checksums: {
            sha256: await crypto.subtle.digest("SHA-256", outputBytes),
          },
          httpMetadata: { contentType: "video/webm" },
          size: outputBytes.byteLength,
        };
      },
    });
    expect(puts[0] instanceof Uint8Array).toBe(true);
    expect(complete).toHaveBeenCalledExactlyOnceWith(
      {},
      expect.objectContaining({
        output: expect.objectContaining({ checksum: outputChecksum }),
      })
    );
  });

  it("proves publication from a hex-string head when put returns null", async () => {
    const outputChecksum = await digestOutput();
    const { complete } = await setup({
      head: async () => ({
        checksums: { sha256: outputChecksum },
        httpMetadata: { contentType: "video/webm" },
        size: outputBytes.byteLength,
      }),
      put: async () => null,
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });

  it("accepts put metadata that reports a hex-string checksum", async () => {
    const outputChecksum = await digestOutput();
    const { complete } = await setup({
      put: async () => ({
        checksums: { sha256: outputChecksum },
        httpMetadata: { contentType: "video/webm" },
        size: outputBytes.byteLength,
      }),
    });
    expect(complete).toHaveBeenCalledTimes(1);
  });
});
