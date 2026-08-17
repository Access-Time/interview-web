import { expect, it } from "vitest";
import {
  candidateJourneyHandoff,
  shouldWarnBeforeUnload,
  usefulError,
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

it("maps screen-sharing permission failures separately from camera access", () => {
  expect(usefulError("Unable to share your screen: permission denied")).toEqual(
    {
      captureBlocked: false,
      message:
        "Screen sharing was blocked. Allow it in your browser, then share the window or display you want to record.",
      title: "Screen sharing blocked",
    }
  );
});
