import type {
  RecordingPlaybackStatus,
  RecordingPlaybackSummary,
} from "@interview-web/db";

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

export async function playbackSummaryLookup(
  getSummary: (input: {
    sessionId: string;
  }) => Promise<RecordingPlaybackSummary>,
  input: { sessionId: string }
): Promise<RecordingPlaybackSummaryLookup> {
  try {
    return {
      kind: "found",
      summary: await getSummary(input),
    };
  } catch (error) {
    if (
      typeof error === "object" &&
      // biome-ignore lint/suspicious/noUnnecessaryConditions: keep the explicit typed oRPC boundary.
      error !== null &&
      "code" in error &&
      error.code === "NOT_FOUND"
    ) {
      return { kind: "missing" };
    }
    throw error;
  }
}
