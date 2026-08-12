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
  const deletes: string[] = [];
  const env = {
    acknowledge: async (
      input: Parameters<NonNullable<typeof overrides.acknowledge>>[0]
    ) => ({
      byteSize: input.byteSize,
      checksum: input.checksum,
      etag: input.etag,
      id: input.partId,
      objectKey: input.objectKey,
    }),
    operatorSecret: "secret",
    storage: {
      delete: (key: string) => {
        deletes.push(key);
        return Promise.resolve();
      },
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
  return { deletes, env, puts };
}

const params = { segmentId: "g1", sequence: "2", sessionId: "s1" };
const request = (authorization = "Bearer secret", contentChecksum = checksum) =>
  new Request("https://example.test", {
    body: "payload",
    duplex: "half",
    headers: {
      Authorization: authorization,
      "X-Content-SHA256": contentChecksum,
    },
    method: "PUT",
  } as RequestInit);

test("unauthorized upload skips storage", async () => {
  const { env, puts } = setup();
  assert.equal(
    (await handleRecordingUploadPart(request("Bearer wrong"), params, env))
      .status,
    401
  );
  assert.equal(puts.length, 0);
});

test("missing or malformed checksum skips storage", async () => {
  await Promise.all(
    [null, "bad", "a".repeat(63), "g".repeat(64)].map(async (value) => {
      const { env, puts } = setup();
      const headers = new Headers({ Authorization: "Bearer secret" });
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
  assert.deepEqual(puts[0]?.options, {
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: checksum,
  });
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

test("conflict does not delete the object", async () => {
  const { env, deletes } = setup({
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
  assert.deepEqual(deletes, []);
});

test("persistence failure compensates the new object", async () => {
  const { env, deletes } = setup({
    acknowledge: () => {
      throw new Error("db");
    },
  });
  assert.equal(
    (await handleRecordingUploadPart(request(), params, env)).status,
    500
  );
  assert.deepEqual(deletes, ["recordings/s1/segments/g1/parts/2"]);
});

test("matching existing R2 retry returns 200 without deleting", async () => {
  const base = setup();
  const { env, deletes } = setup({
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
  assert.deepEqual(deletes, []);
});

test("mismatching existing R2 retry returns 409 without deleting", async () => {
  const base = setup();
  const { env, deletes } = setup({
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
  assert.deepEqual(deletes, []);
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
