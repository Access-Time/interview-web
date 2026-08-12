import assert from "node:assert/strict";
import test from "node:test";
import { handleRecordingUploadPart } from "../src/server/recording-upload.ts";

const checksum = "a".repeat(64);
function setup(
  overrides: Partial<Parameters<typeof handleRecordingUploadPart>[2]> = {}
) {
  const puts: Array<{
    key: string;
    body: ReadableStream<Uint8Array>;
    options: unknown;
  }> = [];
  const env = {
    acknowledge: async (
      input: Parameters<NonNullable<typeof overrides.acknowledge>>[0]
    ) => ({
      byteSize: input.byteSize,
      checksum: input.checksum,
      etag: input.etag,
      id: input.partId,
      mediaType: input.mediaType,
      objectKey: input.objectKey,
    }),
    storage: {
      head: async () => null,
      put: (
        key: string,
        body: ReadableStream<Uint8Array>,
        options: unknown
      ) => {
        puts.push({ body, key, options });
        return Promise.resolve({ etag: "etag-1", size: 7 });
      },
    },
    ...overrides,
  };
  return { env, puts };
}

const params = { segmentId: "g1", sequence: "2", sessionId: "s1" };
const request = (contentChecksum = checksum, mediaType?: string) =>
  new Request("https://example.test", {
    body: new Uint8Array([1, 2, 3]),
    duplex: "half",
    headers: {
      "X-Content-SHA256": contentChecksum,
      ...(mediaType ? { "Content-Type": mediaType } : {}),
    },
    method: "PUT",
  } as RequestInit);

test("missing or malformed checksum skips storage", async () => {
  await Promise.all(
    [null, "bad", "a".repeat(63), "g".repeat(64)].map(async (value) => {
      const { env, puts } = setup();
      const headers = new Headers();
      if (value) {
        headers.set("X-Content-SHA256", value);
      }
      const result = await handleRecordingUploadPart(
        new Request("https://example.test", {
          body: "payload",
          duplex: "half",
          headers,
          method: "PUT",
        } as RequestInit),
        params,
        env
      );
      assert.equal(result.status, 400);
      assert.equal(puts.length, 0);
    })
  );
});

test("success streams and passes conditional R2 metadata", async () => {
  const { env, puts } = setup();
  const response = await handleRecordingUploadPart(request(), params, env);
  assert.equal(response.status, 201);
  assert.ok(puts[0]?.body instanceof ReadableStream);
  assert.equal(
    puts[0]?.key,
    `recordings/s1/segments/g1/parts/2/sha256/${checksum}`
  );
  assert.deepEqual(puts[0]?.options, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: checksum,
  });
});

test("passes Content-Type to acknowledgement and returns authoritative media type", async () => {
  let acknowledgedMediaType: string | null = null;
  const { env } = setup({
    acknowledge: (input) => {
      ({ mediaType: acknowledgedMediaType } = input);
      return Promise.resolve({
        id: "existing",
        ...input,
        mediaType: "video/webm;codecs=opus",
      });
    },
  });
  const response = await handleRecordingUploadPart(
    request(checksum, "video/webm"),
    params,
    env
  );
  assert.equal(acknowledgedMediaType, "video/webm");
  const body: unknown = await response.json();
  assert.ok(body && typeof body === "object" && "mediaType" in body);
  assert.equal(body.mediaType, "video/webm;codecs=opus");
});

test("compatible retry returns 200", async () => {
  const { env } = setup({
    acknowledge: async (input) => ({ id: "existing", ...input }),
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    200
  );
});

test("missing Content-Type is acknowledged as null", async () => {
  let mediaType: string | null = "unexpected";
  const { env } = setup({
    acknowledge: (input) => {
      ({ mediaType } = input);
      return Promise.resolve({ id: "existing", ...input });
    },
  });
  await handleRecordingUploadPart(request(), params, env);
  assert.equal(mediaType, null);
});

test("generic acknowledgement failure retains the new object", async () => {
  const { env } = setup({
    acknowledge: () => {
      throw new Error("db");
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    500
  );
});

test("new-object manifest conflict retains the object", async () => {
  const { env, puts } = setup({
    acknowledge: () => {
      const error = new Error("conflict");
      error.name = "RecordingUploadPartConflictError";
      throw error;
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    409
  );
  assert.equal(puts.length, 1);
});

test("new-object invalid ownership retains the object and returns 404", async () => {
  const { env, puts } = setup({
    acknowledge: () => {
      const error = new Error("ownership");
      error.name = "RecordingSegmentOwnershipError";
      throw error;
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    404
  );
  assert.equal(puts.length, 1);
});

test("pre-existing invalid ownership returns 404", async () => {
  const base = setup();
  const { env, puts } = setup({
    acknowledge: () => {
      const error = new Error("ownership");
      error.name = "RecordingSegmentOwnershipError";
      throw error;
    },
    storage: {
      ...base.env.storage,
      head: async () => ({
        checksums: { sha256: checksum },
        etag: "existing",
        size: 7,
      }),
      put: async () => null,
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    404
  );
  assert.equal(puts.length, 0);
});

test("pre-existing-object manifest conflict returns 409", async () => {
  const base = setup();
  const { env } = setup({
    acknowledge: () => {
      const error = new Error("conflict");
      error.name = "RecordingUploadPartConflictError";
      throw error;
    },
    storage: {
      ...base.env.storage,
      head: async () => ({
        checksums: { sha256: checksum },
        etag: "existing",
        size: 7,
      }),
      put: async () => null,
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    409
  );
});

test("matching existing R2 retry returns 200 without deleting", async () => {
  const base = setup();
  const { env } = setup({
    storage: {
      ...base.env.storage,
      head: async () => ({
        checksums: { sha256: checksum },
        etag: "existing",
        size: 7,
      }),
      put: async () => null,
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    201
  );
});

test("mismatching existing R2 retry returns 409 without deleting", async () => {
  const base = setup();
  const { env } = setup({
    storage: {
      ...base.env.storage,
      head: async () => ({
        checksums: { sha256: "b".repeat(64) },
        etag: "existing",
        size: 7,
      }),
      put: async () => null,
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    409
  );
});

test("malformed sequence is rejected", async () => {
  const { env, puts } = setup();
  assert.equal(
    (
      await handleRecordingUploadPart(
        request(),
        { ...params, sequence: "-1.5" },
        env
      )
    ).status,
    400
  );
  assert.equal(puts.length, 0);
});
