import { expect, it } from "vitest";
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
      mediaType: input.mediaType,
      objectKey: input.objectKey,
    }),
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

it("missing or malformed checksum skips storage", async () => {
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
      expect(result.status).toBe(400);
      expect(puts.length).toBe(0);
    })
  );
});

it("success streams and passes conditional R2 metadata", async () => {
  const { env, puts } = setup();
  const response = await handleRecordingUploadPart(request(), params, env);
  expect(response.status).toBe(201);
  expect(puts[0]?.body instanceof ReadableStream).toBeTruthy();
  expect(puts[0]?.key).toBe(
    `recordings/s1/segments/g1/parts/2/sha256/${checksum}`
  );
  expect(puts[0]?.options).toEqual({
    onlyIf: { etagDoesNotMatch: "*" },
    sha256: checksum,
  });
});

it("passes Content-Type to acknowledgement and returns authoritative media type", async () => {
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
  expect(acknowledgedMediaType).toBe("video/webm");
  const body: unknown = await response.json();
  if (!body || typeof body !== "object" || !("mediaType" in body)) {
    throw new Error("Expected upload response to include mediaType");
  }
  expect(body.mediaType).toBe("video/webm;codecs=opus");
});

it("compatible retry returns 200", async () => {
  const { env } = setup({
    acknowledge: async (input) => ({ id: "existing", ...input }),
  });
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    200
  );
});

it("missing Content-Type is acknowledged as null", async () => {
  let mediaType: string | null = "unexpected";
  const { env } = setup({
    acknowledge: (input) => {
      ({ mediaType } = input);
      return Promise.resolve({ id: "existing", ...input });
    },
  });
  await handleRecordingUploadPart(request(), params, env);
  expect(mediaType).toBe(null);
});

it("generic acknowledgement failure retains the new object", async () => {
  const { env } = setup({
    acknowledge: () => {
      throw new Error("db");
    },
  });
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    500
  );
});

it("new-object manifest conflict retains the candidate for race safety", async () => {
  const { deletes, env, puts } = setup({
    acknowledge: () => {
      const error = new Error("conflict");
      error.name = "RecordingUploadPartConflictError";
      throw error;
    },
  });
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    409
  );
  expect(puts.length).toBe(1);
  // A concurrent acknowledgement may have made this object authoritative in D1.
  expect(deletes).toEqual([]);
});

it("new-object invalid ownership retains the candidate and returns 404", async () => {
  const { deletes, env, puts } = setup({
    acknowledge: () => {
      const error = new Error("ownership");
      error.name = "RecordingSegmentOwnershipError";
      throw error;
    },
  });
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    404
  );
  expect(puts.length).toBe(1);
  expect(deletes).toEqual([]);
});

it("pre-existing invalid ownership returns 404", async () => {
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
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    404
  );
  expect(puts.length).toBe(0);
});

it("pre-existing-object manifest conflict returns 409", async () => {
  const base = setup();
  const { deletes, env } = setup({
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
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    409
  );
  expect(deletes.length).toBe(0);
});

it("new-object conflict does not attempt candidate deletion", async () => {
  const { deletes, env } = setup({
    acknowledge: () => {
      const error = new Error("conflict");
      error.name = "RecordingUploadPartConflictError";
      throw error;
    },
    storage: {
      ...setup().env.storage,
      delete: (key: string) => {
        deletes.push(key);
        return Promise.reject(new Error("r2"));
      },
    },
  });
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    409
  );
  expect(deletes).toEqual([]);
});

it("matching existing R2 retry returns 200 without deleting", async () => {
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
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    201
  );
});

it("matching binary existing R2 checksums return 200", async () => {
  const bytes = Uint8Array.from(checksum.match(/../g) ?? [], (byte) =>
    Number.parseInt(byte, 16)
  );
  await Promise.all(
    [bytes.buffer, bytes].map(async (sha256) => {
      const base = setup();
      const { env } = setup({
        storage: {
          ...base.env.storage,
          head: async () => ({
            checksums: { sha256 },
            etag: "existing",
            size: 7,
          }),
          put: async () => null,
        },
      });
      expect(
        (await handleRecordingUploadPart(request(), params, env)).status
      ).toBe(201);
    })
  );
});

it("mismatching binary existing R2 checksum returns 409", async () => {
  const { env } = setup({
    storage: {
      ...setup().env.storage,
      head: async () => ({
        checksums: { sha256: new Uint8Array(32).buffer },
        etag: "existing",
        size: 7,
      }),
      put: async () => null,
    },
  });
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    409
  );
});

it("mismatching existing R2 retry returns 409 without deleting", async () => {
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
  expect((await handleRecordingUploadPart(request(), params, env)).status).toBe(
    409
  );
});

it("malformed sequence is rejected", async () => {
  const { env, puts } = setup();
  expect(
    (
      await handleRecordingUploadPart(
        request(),
        { ...params, sequence: "-1.5" },
        env
      )
    ).status
  ).toBe(400);
  expect(puts.length).toBe(0);
});
