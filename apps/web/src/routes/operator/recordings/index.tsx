import type {
  RecordingPlaybackCursor,
  RecordingPlaybackSummary,
} from "@interview-web/db";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type PlaybackListErrorKind,
  RecordingPlaybackList,
} from "@/recording/playback-view";
import { client } from "@/utils/orpc";

export const Route = createFileRoute("/operator/recordings/")({
  component: RecordingsIndexRoute,
  head: () => ({ meta: [{ title: "Recordings" }] }),
});

function listErrorKind(
  initialError: boolean,
  loadMoreError: boolean
): PlaybackListErrorKind {
  if (initialError) {
    return "initial";
  }
  if (loadMoreError) {
    return "load-more";
  }
  return null;
}

function RecordingsIndexRoute() {
  const [items, setItems] = useState<RecordingPlaybackSummary[]>([]);
  const [nextCursor, setNextCursor] = useState<RecordingPlaybackCursor | null>(
    null
  );
  const [isLoading, setIsLoading] = useState(true);
  const [initialError, setInitialError] = useState(false);
  const [isLoadingMore, setIsLoadingMore] = useState(false);
  const [loadMoreError, setLoadMoreError] = useState(false);
  const loadGeneration = useRef(0);

  const loadFirstPage = useCallback(() => {
    const generation = loadGeneration.current + 1;
    loadGeneration.current = generation;
    setIsLoading(true);
    setInitialError(false);

    client.recording
      .listPlaybackSummaries({})
      .then((page) => {
        if (loadGeneration.current !== generation) {
          return;
        }
        setItems(page.items);
        setNextCursor(page.nextCursor);
        setLoadMoreError(false);
        setIsLoading(false);
      })
      .catch(() => {
        if (loadGeneration.current !== generation) {
          return;
        }
        setInitialError(true);
        setIsLoading(false);
      });
  }, []);

  useEffect(() => {
    loadFirstPage();
  }, [loadFirstPage]);

  const onLoadMore = useCallback(() => {
    if (!nextCursor || isLoadingMore) {
      return;
    }
    setIsLoadingMore(true);
    setLoadMoreError(false);
    client.recording
      .listPlaybackSummaries({ cursor: nextCursor })
      .then((page) => {
        setItems((current) => [...current, ...page.items]);
        setNextCursor(page.nextCursor);
        setLoadMoreError(false);
        setIsLoadingMore(false);
      })
      .catch(() => {
        setLoadMoreError(true);
        setIsLoadingMore(false);
      });
  }, [isLoadingMore, nextCursor]);

  return (
    <RecordingPlaybackList
      errorKind={listErrorKind(initialError, loadMoreError)}
      isLoading={isLoading}
      isLoadingMore={isLoadingMore}
      items={items}
      nextCursor={nextCursor}
      onLoadMore={onLoadMore}
      onRetry={loadFirstPage}
    />
  );
}
