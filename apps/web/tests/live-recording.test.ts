import { describe, expect, it, vi } from "vitest";
import { createLiveRecordingOutbox } from "../src/recording/live-recording";

const part = {
  blob: new Blob(["media"]),
  mediaType: "video/webm",
  segmentId: "segment",
  sequence: 0,
  sessionId: "session",
};

describe("recording outbox", () => {
  it("persists parts, reports bytes, and drains in append order", async () => {
    const stored = new Map<string, typeof part>();
    const request = vi.fn(async () => new Response(null, { status: 204 }));
    const box = createLiveRecordingOutbox(
      {
        delete: (value) => {
          stored.delete(`${value.sessionId}:${value.sequence}`);
          return Promise.resolve();
        },
        discardSession: async () => undefined,
        listParts: async () => [...stored.values()],
        put: (value) => {
          stored.set(`${value.sessionId}:${value.sequence}`, value);
          return Promise.resolve();
        },
      },
      request
    );
    await box.persistPart(part);
    await box.drain();
    expect(box.getPersistedBytes()).toBe(0);
    expect(box.hasUnsentMedia()).toBe(false);
    expect(request).toHaveBeenCalledOnce();
  });

  it("retains a locally persisted part when upload fails", async () => {
    const request = vi.fn(async () => new Response(null, { status: 503 }));
    const box = createLiveRecordingOutbox(
      {
        delete: async () => undefined,
        discardSession: async () => undefined,
        listParts: async () => [],
        put: async () => undefined,
      },
      request
    );
    await box.persistPart(part);
    expect(box.hasUnsentMedia()).toBe(true);
    await expect(box.drain()).rejects.toThrow("still pending");
  });
});
