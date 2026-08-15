import { expect, it } from "vitest";
import {
  candidateJourneyHandoff,
  shouldWarnBeforeUnload,
} from "../src/routes/index";

it("warns while capture or unsent media remains", () => {
  expect(
    shouldWarnBeforeUnload({
      hasIncompleteRecordingFinalization: false,
      hasUnsentRecordingMedia: true,
      recording: false,
    })
  ).toBe(true);
});

it("hands off a local save failure as a blocking error", () => {
  const handoff = candidateJourneyHandoff({
    recordingError: "IndexedDB storage unavailable",
  });
  expect(handoff.captureBlocked).toBe(true);
});
