import type { RecordingPlaybackSummary } from "@interview-web/db";
import { expect, it } from "vitest";
import {
  isPlaybackReady,
  playbackDetailKind,
  playbackStatusLabel,
  playbackSummaryLookup,
  recordingSubmissionUrl,
} from "../src/recording/playback";

const summary: RecordingPlaybackSummary = {
  createdAt: 1_725_000_000_000,
  hasOutput: true,
  id: "session-1",
  outputByteSize: 1024,
  outputMediaType: "video/webm",
  status: "ready",
};

it("labels every recording lifecycle status", () => {
  expect(playbackStatusLabel("recording")).toBe("Recording");
  expect(playbackStatusLabel("queued")).toBe("Preparing");
  expect(playbackStatusLabel("finalizing")).toBe("Preparing");
  expect(playbackStatusLabel("ready")).toBe("Ready to play");
  expect(playbackStatusLabel("failed")).toBe("Unavailable");
  expect(playbackStatusLabel("deleting")).toBe("Removing");
});

it("treats only a ready summary with output as playable", () => {
  expect(
    isPlaybackReady({ ...summary, hasOutput: true, status: "ready" })
  ).toBe(true);
  expect(
    isPlaybackReady({ ...summary, hasOutput: false, status: "ready" })
  ).toBe(false);
  expect(
    isPlaybackReady({ ...summary, hasOutput: true, status: "finalizing" })
  ).toBe(false);
});

it("classifies detail playback kinds from status and output", () => {
  expect(playbackDetailKind({ ...summary, status: "recording" })).toBe(
    "processing"
  );
  expect(playbackDetailKind({ ...summary, status: "queued" })).toBe(
    "processing"
  );
  expect(playbackDetailKind({ ...summary, status: "finalizing" })).toBe(
    "processing"
  );
  expect(
    playbackDetailKind({ ...summary, hasOutput: true, status: "ready" })
  ).toBe("playable");
  expect(
    playbackDetailKind({ ...summary, hasOutput: false, status: "ready" })
  ).toBe("unavailable");
  expect(playbackDetailKind({ ...summary, status: "failed" })).toBe(
    "unavailable"
  );
  expect(playbackDetailKind({ ...summary, status: "deleting" })).toBe(
    "unavailable"
  );
});

it("builds an encoded same-origin submission URL", () => {
  expect(recordingSubmissionUrl("session/a?b")).toBe(
    "/api/recordings/session%2Fa%3Fb/submission"
  );
});

it("maps a missing summary lookup to a typed missing result", async () => {
  await expect(
    playbackSummaryLookup(
      async () => Promise.reject({ code: "RECORDING_NOT_FOUND" }),
      {
        sessionId: "missing",
      }
    )
  ).resolves.toEqual({ kind: "missing" });
});

it("rethrows non-missing lookup errors without wrapping them", async () => {
  await expect(
    playbackSummaryLookup(
      async () => Promise.reject(new Error("network unavailable")),
      { sessionId: "session-1" }
    )
  ).rejects.toThrow("network unavailable");
});
