import assert from "node:assert/strict";
import test from "node:test";
import { handleRecordingSubmission } from "../src/server/recording-submission.ts";

const key = "recordings/s1/final.webm";
function setup(overrides: Record<string, unknown> = {}) {
  const deleted: string[] = [];
  const metadata = { contentType: "video/webm", httpEtag: '"e1"', size: 5 };
  const env = {
    beginDeletion: async () => ({
      activeLeaseExpiresAt: null,
      state: "deleting" as const,
    }),
    completeDeletion: async () => true,
    getReadySubmission: async () => ({ objectKey: key }),
    storage: {
      delete: (objectKey: string) => {
        deleted.push(objectKey);
        return Promise.resolve();
      },
      get: async (
        _key: string,
        range?: { offset: number; length: number }
      ) => ({
        ...metadata,
        body: new ReadableStream({
          start(c) {
            c.enqueue(new Uint8Array(range ? range.length : 5));
            c.close();
          },
        }),
      }),
      head: async () => metadata,
      list: async () => ({ objects: [], truncated: false }),
    },
    ...overrides,
  } as Parameters<typeof handleRecordingSubmission>[2];
  return { deleted, env };
}

test("missing and non-ready submissions return 404; ready missing storage returns 503", async () => {
  const missing = setup({ getReadySubmission: async () => null });
  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x"),
        { sessionId: "s1" },
        missing.env
      )
    ).status,
    404
  );
  const absent = setup({
    storage: { ...setup().env.storage, head: async () => null },
  });
  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x"),
        { sessionId: "s1" },
        absent.env
      )
    ).status,
    503
  );
});

test("uses provider ranges for open-ended, suffix, and HEAD requests", async () => {
  let requested: unknown;
  const { env } = setup({
    storage: {
      ...setup().env.storage,
      get: (_key: string, range?: { offset: number; length: number }) => {
        requested = range;
        return Promise.resolve({
          body: new ReadableStream({
            start(c) {
              c.close();
            },
          }),
          httpEtag: '"e1"',
          size: 5,
        });
      },
    },
  });
  const open = await handleRecordingSubmission(
    new Request("https://x", { headers: { Range: "bytes=2-" } }),
    { sessionId: "s1" },
    env
  );
  assert.equal(open.status, 206);
  assert.deepEqual(requested, { length: 3, offset: 2 });
  const suffix = await handleRecordingSubmission(
    new Request("https://x", { headers: { Range: "bytes=-2" } }),
    { sessionId: "s1" },
    env
  );
  assert.equal(suffix.status, 206);
  assert.deepEqual(requested, { length: 2, offset: 3 });
  requested = undefined;
  const head = await handleRecordingSubmission(
    new Request("https://x", {
      headers: { Range: "bytes=1-2" },
      method: "HEAD",
    }),
    { sessionId: "s1" },
    env
  );
  assert.equal(head.status, 206);
  assert.equal(requested, undefined);
  assert.equal(head.headers.get("Content-Range"), "bytes 1-2/5");
  assert.equal(head.headers.get("ETag"), '"e1"');
});

test("returns complete 416 headers for unsatisfiable ranges", async () => {
  const { env } = setup();
  const response = await handleRecordingSubmission(
    new Request("https://x", { headers: { Range: "bytes=9-10" } }),
    { sessionId: "s1" },
    env
  );
  assert.equal(response.status, 416);
  assert.equal(response.headers.get("Content-Length"), "0");
  assert.equal(response.headers.get("Content-Range"), "bytes */5");
});

test("missing and leased deletion are idempotent", async () => {
  const missing = setup({
    beginDeletion: async () => ({
      activeLeaseExpiresAt: null,
      state: "missing" as const,
    }),
  });
  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x", { method: "DELETE" }),
        { sessionId: "s1" },
        missing.env
      )
    ).status,
    204
  );
  const leased = setup({
    beginDeletion: async () => ({
      activeLeaseExpiresAt: Date.now() + 1000,
      state: "deleting" as const,
    }),
  });
  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x", { method: "DELETE" }),
        { sessionId: "s1" },
        leased.env
      )
    ).status,
    202
  );
});

test("missing deletion sweeps the encoded session prefix", async () => {
  const listed: string[] = [];
  const { env, deleted } = setup({
    beginDeletion: async () => ({
      activeLeaseExpiresAt: null,
      state: "missing" as const,
    }),
    storage: {
      ...setup().env.storage,
      delete: (storageKey: string) => {
        deleted.push(storageKey);
        return Promise.resolve();
      },
      list: (prefix: string) => {
        listed.push(prefix);
        return listed.length === 1
          ? { objects: [{ key: `${prefix}late-part` }], truncated: false }
          : { objects: [], truncated: false };
      },
    },
  });
  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x", { method: "DELETE" }),
        { sessionId: "s/1" },
        env
      )
    ).status,
    204
  );
  assert.deepEqual(listed, ["recordings/s%2F1/", "recordings/s%2F1/"]);
  assert.deepEqual(deleted, ["recordings/s%2F1/late-part"]);
});

test("sweeps only the encoded prefix and completes after verification", async () => {
  const events: string[] = [];
  const { env, deleted } = setup({
    completeDeletion: () => {
      events.push("complete");
      return Promise.resolve(true);
    },
    storage: {
      ...setup().env.storage,
      delete: (objectKey: string) => {
        events.push(`delete:${objectKey}`);
        deleted.push(objectKey);
        return Promise.resolve();
      },
      list: async (prefix: string) => ({
        objects: [{ key: `${prefix}part` }, { key: "recordings/s10/nope" }],
        truncated: false,
      }),
    },
  });
  // A mutating provider returns the same item until the deletion callback removes it.
  (env.storage.delete as unknown as (key: string) => Promise<void>) = (
    objectKey: string
  ) => {
    events.push(`delete:${objectKey}`);
    deleted.push(objectKey);
    env.storage.list = async () => ({ objects: [], truncated: false });
    return Promise.resolve();
  };
  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x", { method: "DELETE" }),
        { sessionId: "s1" },
        env
      )
    ).status,
    204
  );
  assert.deepEqual(deleted, ["recordings/s1/part"]);
  assert.equal(events.at(-1), "complete");
});

test("passes pagination cursors while sweeping only the encoded prefix", async () => {
  const calls: [string, string | undefined][] = [];
  const swept: string[] = [];
  const { env } = setup({
    storage: {
      ...setup().env.storage,
      delete: (objectKey: string) => {
        swept.push(objectKey);
        return Promise.resolve();
      },
      list: (prefix: string, cursor?: string) => {
        calls.push([prefix, cursor]);
        if (calls.length === 1) {
          return Promise.resolve({
            cursor: "page-2",
            objects: [
              { key: `${prefix}first` },
              { key: "recordings/s10/nope" },
            ],
            truncated: true,
          });
        }
        if (cursor === "page-2") {
          return Promise.resolve({
            objects: [
              { key: `${prefix}second` },
              { key: "recordings/other/nope" },
            ],
            truncated: false,
          });
        }
        return Promise.resolve({ objects: [], truncated: false });
      },
    },
  });

  assert.equal(
    (
      await handleRecordingSubmission(
        new Request("https://x", { method: "DELETE" }),
        { sessionId: "s/1" },
        env
      )
    ).status,
    204
  );
  assert.deepEqual(calls, [
    ["recordings/s%2F1/", undefined],
    ["recordings/s%2F1/", "page-2"],
    ["recordings/s%2F1/", undefined],
  ]);
  assert.deepEqual(swept, [
    "recordings/s%2F1/first",
    "recordings/s%2F1/second",
  ]);
});
