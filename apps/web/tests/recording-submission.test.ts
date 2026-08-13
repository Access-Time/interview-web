import { describe, expect, it } from "vitest";
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

describe("recording submission", () => {
  it("returns 404 for a missing submission", async () => {
    const missing = setup({ getReadySubmission: async () => null });
    const response = await handleRecordingSubmission(
      new Request("https://x"),
      { sessionId: "s1" },
      missing.env
    );
    expect(response.status).toBe(404);
  });

  it("returns 503 when ready submission storage is missing", async () => {
    const absent = setup({
      storage: { ...setup().env.storage, head: async () => null },
    });
    const response = await handleRecordingSubmission(
      new Request("https://x"),
      { sessionId: "s1" },
      absent.env
    );
    expect(response.status).toBe(503);
  });

  it("uses provider ranges for open-ended, suffix, and HEAD requests", async () => {
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
    expect(open.status).toBe(206);
    expect(requested).toEqual({ length: 3, offset: 2 });
    const suffix = await handleRecordingSubmission(
      new Request("https://x", { headers: { Range: "bytes=-2" } }),
      { sessionId: "s1" },
      env
    );
    expect(suffix.status).toBe(206);
    expect(requested).toEqual({ length: 2, offset: 3 });
    requested = undefined;
    const head = await handleRecordingSubmission(
      new Request("https://x", {
        headers: { Range: "bytes=1-2" },
        method: "HEAD",
      }),
      { sessionId: "s1" },
      env
    );
    expect(head.status).toBe(206);
    expect(requested).toBeUndefined();
    expect(head.headers.get("Content-Range")).toBe("bytes 1-2/5");
    expect(head.headers.get("ETag")).toBe('"e1"');
  });

  it("returns complete 416 headers for unsatisfiable ranges", async () => {
    const { env } = setup();
    const response = await handleRecordingSubmission(
      new Request("https://x", { headers: { Range: "bytes=9-10" } }),
      { sessionId: "s1" },
      env
    );
    expect(response.status).toBe(416);
    expect(response.headers.get("Content-Length")).toBe("0");
    expect(response.headers.get("Content-Range")).toBe("bytes */5");
  });

  it("missing and leased deletion are idempotent", async () => {
    const missing = setup({
      beginDeletion: async () => ({
        activeLeaseExpiresAt: null,
        state: "missing" as const,
      }),
    });
    expect(
      (
        await handleRecordingSubmission(
          new Request("https://x", { method: "DELETE" }),
          { sessionId: "s1" },
          missing.env
        )
      ).status
    ).toBe(204);
    const leased = setup({
      beginDeletion: async () => ({
        activeLeaseExpiresAt: Date.now() + 1000,
        state: "deleting" as const,
      }),
    });
    expect(
      (
        await handleRecordingSubmission(
          new Request("https://x", { method: "DELETE" }),
          { sessionId: "s1" },
          leased.env
        )
      ).status
    ).toBe(202);
  });

  it("missing deletion sweeps the encoded session prefix", async () => {
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
    expect(
      (
        await handleRecordingSubmission(
          new Request("https://x", { method: "DELETE" }),
          { sessionId: "s/1" },
          env
        )
      ).status
    ).toBe(204);
    expect(listed).toEqual(["recordings/s%2F1/", "recordings/s%2F1/"]);
    expect(deleted).toEqual(["recordings/s%2F1/late-part"]);
  });

  it("sweeps only the encoded prefix and completes after verification", async () => {
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
    expect(
      (
        await handleRecordingSubmission(
          new Request("https://x", { method: "DELETE" }),
          { sessionId: "s1" },
          env
        )
      ).status
    ).toBe(204);
    expect(deleted).toEqual(["recordings/s1/part"]);
    expect(events.at(-1)).toBe("complete");
  });

  it("passes pagination cursors while sweeping only the encoded prefix", async () => {
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

    expect(
      (
        await handleRecordingSubmission(
          new Request("https://x", { method: "DELETE" }),
          { sessionId: "s/1" },
          env
        )
      ).status
    ).toBe(204);
    expect(calls).toEqual([
      ["recordings/s%2F1/", undefined],
      ["recordings/s%2F1/", "page-2"],
      ["recordings/s%2F1/", undefined],
    ]);
    expect(swept).toEqual([
      "recordings/s%2F1/first",
      "recordings/s%2F1/second",
    ]);
  });
});
