import { expect, it } from "vitest";
import type { UseLiveRecordingResult } from "../src/recording/live-recording";

it("keeps the hook surface focused on unsent media", () => {
  const result = {} as Partial<UseLiveRecordingResult>;
  expect("hasUnsentRecordingMedia" in result).toBe(false);
  expect("recordingDeliveryPhase" in result).toBe(false);
});
