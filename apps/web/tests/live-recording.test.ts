import { describe, expect, it, vi } from "vitest";
import { createLiveRecordingOutbox } from "../src/recording/live-recording";

const part = {
  blob: new Blob(["media"]),
  mediaType: "video/webm",
  segmentId: "segment",
  sequence: 0,
  sessionId: "session",
};
const partPath = /parts\/(\d+)/;

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
    expect(request).toHaveBeenCalledWith(
      expect.any(String),
      expect.objectContaining({
        headers: expect.objectContaining({
          "X-Content-SHA256": expect.any(String),
        }),
      })
    );
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

  it("drains hydrated parts by numeric sequence", async () => {
    const parts = [
      { ...part, sequence: 10 },
      { ...part, sequence: 2 },
      { ...part, sequence: 1 },
    ];
    const retained = [...parts];
    const calls: number[] = [];
    const box = createLiveRecordingOutbox(
      {
        delete: (value) => {
          const index = retained.findIndex(
            (item) => item.sequence === value.sequence
          );
          if (index >= 0) {
            retained.splice(index, 1);
          }
          return Promise.resolve();
        },
        discardSession: async () => undefined,
        listParts: async () => retained,
        put: async () => undefined,
      },
      (url) => {
        const match = String(url).match(partPath);
        calls.push(Number(match?.[1]));
        return Promise.resolve(new Response(null, { status: 204 }));
      }
    );
    await box.hydrate();
    await box.drain();
    expect(calls).toEqual([1, 2, 10]);
  });

  it("retains temporary failures and clears stale save state after success", async () => {
    const request = vi
      .fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response(null, { status: 204 }));
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
    await box.drain().catch(() => undefined);
    expect(box.hasUnsentMedia()).toBe(true);
    expect(box.saveState).toBe("error");
    await box.setOnline(false);
    await box.setOnline(true);
    await box.drain();
    expect(box.saveState).toBe("healthy");
    expect(box.hasUnsentMedia()).toBe(false);
  });
});
