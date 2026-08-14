import type { RecordingPlaybackSummary } from "@interview-web/db";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import { playbackSummaryLookup } from "@/recording/playback";
import {
  type PlaybackLookupKind,
  RecordingPlaybackDetail,
} from "@/recording/playback-view";
import { client } from "@/utils/orpc";

export const Route = createFileRoute("/operator/recordings/$sessionId")({
  component: RecordingPlaybackRoute,
  head: () => ({ meta: [{ title: "Recording playback" }] }),
});

function RecordingPlaybackRoute() {
  const { sessionId } = Route.useParams();
  const [lookupKind, setLookupKind] = useState<PlaybackLookupKind>("loading");
  const [summary, setSummary] = useState<RecordingPlaybackSummary | null>(null);
  const [mediaFailed, setMediaFailed] = useState(false);
  const [retryNonce, setRetryNonce] = useState(0);
  const lookupGeneration = useRef(0);

  const loadSummary = useCallback(() => {
    const generation = lookupGeneration.current + 1;
    lookupGeneration.current = generation;
    setLookupKind("loading");

    playbackSummaryLookup(client.recording.getPlaybackSummary, { sessionId })
      .then((result) => {
        if (lookupGeneration.current !== generation) {
          return;
        }
        if (result.kind === "missing") {
          setSummary(null);
          setLookupKind("missing");
          return;
        }
        setSummary(result.summary);
        setMediaFailed(false);
        setLookupKind("found");
      })
      .catch(() => {
        if (lookupGeneration.current !== generation) {
          return;
        }
        setLookupKind("error");
      });
  }, [sessionId]);

  useEffect(() => {
    loadSummary();
  }, [loadSummary]);

  const onRetryPlayback = useCallback(() => {
    setMediaFailed(false);
    setRetryNonce((value) => value + 1);
  }, []);

  return (
    <RecordingPlaybackDetail
      lookupKind={lookupKind}
      mediaFailed={mediaFailed}
      onRetryLookup={loadSummary}
      onRetryPlayback={onRetryPlayback}
      retryNonce={retryNonce}
      summary={summary}
    />
  );
}
