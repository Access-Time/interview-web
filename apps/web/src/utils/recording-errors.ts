import type { ApiErrors } from "./orpc";

type RecordingNotFoundError = Extract<
  | ApiErrors["recording"]["getManifest"]
  | ApiErrors["recording"]["getPlaybackSummary"]
  | ApiErrors["recording"]["getStatus"],
  { code: "RECORDING_NOT_FOUND" }
>;

export function isRecordingNotFoundError(
  error: unknown
): error is RecordingNotFoundError {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "RECORDING_NOT_FOUND"
  );
}
