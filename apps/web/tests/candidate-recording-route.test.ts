import { expect, it } from "vitest";
import {
  candidateJourneyHandoff,
  shouldWarnBeforeUnload,
} from "../src/routes/index";

it.each([
  {
    hasIncompleteRecordingFinalization: false,
    hasUnsentRecordingMedia: false,
    recording: true,
  },
  {
    hasIncompleteRecordingFinalization: true,
    hasUnsentRecordingMedia: false,
    recording: false,
  },
  {
    hasIncompleteRecordingFinalization: false,
    hasUnsentRecordingMedia: true,
    recording: false,
  },
])("warns before unload for active recording state %#", (input) => {
  expect(shouldWarnBeforeUnload(input)).toBe(true);
});

it("hands off a local save failure as a blocking error", () => {
  const handoff = candidateJourneyHandoff({
    recordingError: "IndexedDB storage unavailable",
  });
  expect(handoff.captureBlocked).toBe(true);
});
