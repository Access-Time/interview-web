import type { RecordingPlaybackCursor } from "@interview-web/db";
import { useInfiniteQuery } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useCallback } from "react";
import {
  type PlaybackListErrorKind,
  RecordingPlaybackList,
} from "@/recording/playback-view";
import { orpc } from "@/utils/orpc";

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
  const listQuery = useInfiniteQuery(
    orpc.recording.listPlaybackSummaries.infiniteOptions({
      getNextPageParam: (lastPage) => lastPage.nextCursor ?? undefined,
      initialPageParam: undefined as RecordingPlaybackCursor | undefined,
      input: (cursor: RecordingPlaybackCursor | undefined) => ({ cursor }),
    })
  );

  const items = listQuery.data?.pages.flatMap((page) => page.items) ?? [];
  const nextCursor = listQuery.data?.pages.at(-1)?.nextCursor ?? null;
  const onLoadMore = useCallback(() => {
    if (listQuery.hasNextPage && !listQuery.isFetchingNextPage) {
      listQuery.fetchNextPage();
    }
  }, [listQuery]);
  const onRetry = useCallback(() => {
    listQuery.refetch();
  }, [listQuery]);

  return (
    <RecordingPlaybackList
      errorKind={listErrorKind(
        listQuery.isError && !listQuery.data,
        listQuery.isFetchNextPageError
      )}
      isLoading={listQuery.isPending}
      isLoadingMore={listQuery.isFetchingNextPage}
      items={items}
      nextCursor={nextCursor}
      onLoadMore={onLoadMore}
      onRetry={onRetry}
    />
  );
}
