import { useQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useState } from "react";
import {
  type PlaybackLookupKind,
  RecordingPlaybackDetail,
} from "@/recording/playback-view";
import { orpc } from "@/utils/orpc";
import { isRecordingNotFoundError } from "@/utils/recording-errors";

export const Route = createFileRoute("/operator/recordings/$sessionId")({
  component: RecordingPlaybackRoute,
  head: () => ({ meta: [{ title: "Recording playback" }] }),
});

function lookupKind(
  isPending: boolean,
  error: unknown,
  hasSummary: boolean
): PlaybackLookupKind {
  if (isPending) {
    return "loading";
  }
  if (isRecordingNotFoundError(error)) {
    return "missing";
  }
  if (error) {
    return "error";
  }
  return hasSummary ? "found" : "loading";
}

function RecordingPlaybackRoute() {
  const { sessionId } = Route.useParams();
  const [retryNonce, setRetryNonce] = useState(0);
  const summaryQuery = useQuery({
    ...orpc.recording.getPlaybackSummary.queryOptions({
      input: { sessionId },
    }),
    retry: false,
  });

  const onRetryPlayback = useCallback(() => {
    setRetryNonce((value) => value + 1);
  }, []);
  const onRetryLookup = useCallback(() => {
    summaryQuery.refetch();
  }, [summaryQuery]);

  return (
    <RecordingPlaybackDetail
      lookupKind={lookupKind(
        summaryQuery.isPending,
        summaryQuery.error,
        Boolean(summaryQuery.data)
      )}
      mediaFailed={false}
      onRetryLookup={onRetryLookup}
      onRetryPlayback={onRetryPlayback}
      retryNonce={retryNonce}
      summary={summaryQuery.data ?? null}
    />
  );
}
