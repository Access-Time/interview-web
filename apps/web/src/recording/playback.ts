import type {
  RecordingPlaybackStatus,
  RecordingPlaybackSummary,
} from "@interview-web/db";
import { makeWebmSeekable } from "@interview-web/finalizer/webm-seekable";
import type { ApiErrors } from "@/utils/orpc";
import { isRecordingNotFoundError } from "@/utils/recording-errors";

export type PlaybackDetailKind = "playable" | "processing" | "unavailable";

export type RecordingPlaybackSummaryLookup =
  | { kind: "found"; summary: RecordingPlaybackSummary }
  | { kind: "missing" };

export function playbackStatusLabel(status: RecordingPlaybackStatus): string {
  switch (status) {
    case "recording":
      return "Recording";
    case "queued":
    case "finalizing":
      return "Preparing";
    case "ready":
      return "Ready to play";
    case "failed":
      return "Unavailable";
    case "deleting":
      return "Removing";
    default: {
      const exhaustive: never = status;
      return exhaustive;
    }
  }
}

export function isPlaybackReady(summary: RecordingPlaybackSummary): boolean {
  return summary.status === "ready" && summary.hasOutput;
}

export function playbackDetailKind(
  summary: RecordingPlaybackSummary
): PlaybackDetailKind {
  if (isPlaybackReady(summary)) {
    return "playable";
  }
  switch (summary.status) {
    case "recording":
    case "queued":
    case "finalizing":
      return "processing";
    case "ready":
    case "failed":
    case "deleting":
      return "unavailable";
    default: {
      const exhaustive: never = summary.status;
      return exhaustive;
    }
  }
}

export function recordingSubmissionUrl(sessionId: string): string {
  return `/api/recordings/${encodeURIComponent(sessionId)}/submission`;
}

export async function preparePlaybackObjectUrl(
  sessionId: string,
  mediaType: string | null,
  fetchImpl: typeof fetch = fetch
): Promise<string> {
  const response = await fetchImpl(recordingSubmissionUrl(sessionId));
  if (!response.ok) {
    throw new Error("Recording playback could not be loaded");
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  const body =
    (mediaType ?? "video/webm").split(";")[0] === "video/webm"
      ? makeWebmSeekable(bytes)
      : bytes;
  const blobBytes = new Uint8Array(body.byteLength);
  blobBytes.set(body);
  return URL.createObjectURL(
    new Blob([blobBytes], { type: mediaType ?? "video/webm" })
  );
}

export function playbackSummaryLookup(
  getSummary: (input: {
    sessionId: string;
  }) => Promise<RecordingPlaybackSummary>,
  input: { sessionId: string }
): Promise<RecordingPlaybackSummaryLookup> {
  return getSummary(input).then(
    (summary) => ({ kind: "found", summary }),
    (error: ApiErrors["recording"]["getPlaybackSummary"]) => {
      if (isRecordingNotFoundError(error)) {
        return { kind: "missing" };
      }
      throw error;
    }
  );
}
