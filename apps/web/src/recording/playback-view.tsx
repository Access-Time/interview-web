import { Button } from "@cloudflare/kumo/components/button";
import type {
  RecordingPlaybackCursor,
  RecordingPlaybackSummary,
} from "@interview-web/db";
import { Link } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import {
  isPlaybackReady,
  playbackDetailKind,
  playbackStatusLabel,
  preparePlaybackObjectUrls,
} from "./playback";

export type PlaybackListErrorKind = "initial" | "load-more" | null;
export type PlaybackLookupKind = "loading" | "found" | "missing" | "error";

const LOAD_ERROR_MESSAGE = "We couldn't load recordings. Try again.";
const LOOKUP_ERROR_MESSAGE = "We couldn't load this recording. Try again.";
const PROCESSING_MESSAGE = "This recording is still being prepared.";
const UNAVAILABLE_MESSAGE = "Recording unavailable";
const BYTES_PER_KIBIBYTE = 1024;
const BYTES_PER_MEBIBYTE = BYTES_PER_KIBIBYTE * 1024;

const actionClassName =
  "min-h-11 rounded-lg !bg-white px-5 font-medium !text-black hover:!bg-neutral-200 focus-visible:ring-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 forced-colors:outline";
const linkClassName =
  "inline-flex min-h-11 items-center font-medium text-white underline decoration-white/40 underline-offset-4 hover:decoration-white focus-visible:outline focus-visible:outline-2 focus-visible:outline-white focus-visible:outline-offset-2 forced-colors:outline";

export interface RecordingPlaybackListProps {
  errorKind: PlaybackListErrorKind;
  isLoading: boolean;
  isLoadingMore: boolean;
  items: RecordingPlaybackSummary[];
  nextCursor: RecordingPlaybackCursor | null;
  onLoadMore: () => void;
  onRetry: () => void;
}

export interface RecordingPlaybackDetailProps {
  lookupKind: PlaybackLookupKind;
  mediaFailed: boolean;
  onRetryLookup: () => void;
  onRetryPlayback: () => void;
  retryNonce: number;
  summary: RecordingPlaybackSummary | null;
}

function formatCreatedAt(createdAt: number): string {
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(createdAt));
}

function formatOutputByteSize(bytes: number): string {
  if (bytes >= BYTES_PER_MEBIBYTE) {
    return `${(bytes / BYTES_PER_MEBIBYTE).toFixed(1)} MB`;
  }
  if (bytes >= BYTES_PER_KIBIBYTE) {
    return `${(bytes / BYTES_PER_KIBIBYTE).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function listAnnouncement(props: RecordingPlaybackListProps): string {
  if (props.isLoading) {
    return "Loading recordings.";
  }
  if (props.errorKind === "initial" || props.errorKind === "load-more") {
    return LOAD_ERROR_MESSAGE;
  }
  if (props.isLoadingMore) {
    return "Loading more recordings.";
  }
  return "";
}

function RecordingOutputMeta({
  summary,
}: {
  summary: RecordingPlaybackSummary;
}) {
  const parts: string[] = [];
  if (summary.outputMediaType) {
    parts.push(summary.outputMediaType);
  }
  if (summary.outputByteSize !== null) {
    parts.push(formatOutputByteSize(summary.outputByteSize));
  }
  if (parts.length === 0) {
    return null;
  }
  return <p className="mt-1 text-sm text-white/55">{parts.join(" · ")}</p>;
}

function RecordingListItem({ summary }: { summary: RecordingPlaybackSummary }) {
  const createdLabel = formatCreatedAt(summary.createdAt);
  return (
    <li className="rounded-xl border border-white/15 px-4 py-4 sm:px-5">
      <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
        <div className="min-w-0">
          <time
            className="text-sm text-white/80"
            dateTime={new Date(summary.createdAt).toISOString()}
          >
            {createdLabel}
          </time>
          <p className="mt-1 text-sm text-white/70">
            {playbackStatusLabel(summary.status)}
          </p>
          <RecordingOutputMeta summary={summary} />
        </div>
        <Link
          className={`${linkClassName} shrink-0`}
          params={{ sessionId: summary.id }}
          to="/operator/recordings/$sessionId"
        >
          {isPlaybackReady(summary) ? "Play recording" : "View status"}
        </Link>
      </div>
    </li>
  );
}

export function RecordingPlaybackList(
  props: RecordingPlaybackListProps
): React.JSX.Element {
  const announcement = listAnnouncement(props);
  const showInitialError = props.errorKind === "initial" && !props.isLoading;
  const showEmpty =
    !(props.isLoading || showInitialError) && props.items.length === 0;
  const showItems = props.items.length > 0;

  return (
    <main className="min-h-dvh bg-black text-white">
      <div className="mx-auto flex max-w-3xl flex-col gap-8 px-4 py-8 sm:px-8 sm:py-12">
        <div className="grid gap-1.5">
          <h1 className="font-semibold text-4xl leading-tight sm:text-5xl">
            Recordings
          </h1>
          <p className="text-sm text-white/60 leading-6">
            Browse every session. Ready recordings can be played in the browser.
          </p>
        </div>
        {announcement ? (
          <p aria-live="polite" className="text-sm text-white/80">
            {announcement}
          </p>
        ) : null}
        {showInitialError ? (
          <Button
            className={`${actionClassName} w-fit`}
            onClick={props.onRetry}
            type="button"
          >
            Try again
          </Button>
        ) : null}
        {showEmpty ? (
          <p className="text-sm text-white/70">No recordings yet.</p>
        ) : null}
        {showItems ? (
          <ul className="grid gap-3">
            {props.items.map((item) => (
              <RecordingListItem key={item.id} summary={item} />
            ))}
          </ul>
        ) : null}
        {props.nextCursor ? (
          <Button
            className={`${actionClassName} w-fit`}
            disabled={props.isLoadingMore}
            onClick={props.onLoadMore}
            type="button"
          >
            Load more
          </Button>
        ) : null}
      </div>
    </main>
  );
}

function DetailReturnLink() {
  return (
    <Link className={linkClassName} to="/operator/recordings">
      Back to recordings
    </Link>
  );
}

function PlayableRecording({
  mediaFailed,
  onRetryPlayback,
  retryNonce,
  summary,
}: {
  mediaFailed: boolean;
  onRetryPlayback: () => void;
  retryNonce: number;
  summary: RecordingPlaybackSummary;
}) {
  const [failedForNonce, setFailedForNonce] = useState<number | null>(null);
  const [objectUrls, setObjectUrls] = useState<string[]>([]);
  const [partIndex, setPartIndex] = useState(0);
  const handleMediaError = useCallback(() => {
    setFailedForNonce(retryNonce);
  }, [retryNonce]);
  const handlePartEnded = useCallback(() => {
    setPartIndex((current) =>
      current + 1 < objectUrls.length ? current + 1 : current
    );
  }, [objectUrls.length]);
  const handlePreviousPart = useCallback(() => {
    setPartIndex((current) => Math.max(0, current - 1));
  }, []);
  const handleNextPart = useCallback(() => {
    setPartIndex((current) =>
      current + 1 < objectUrls.length ? current + 1 : current
    );
  }, [objectUrls.length]);
  const playbackFailed = mediaFailed || failedForNonce === retryNonce;
  const activeUrl = objectUrls[partIndex] ?? objectUrls[0] ?? null;

  useEffect(() => {
    let cancelled = false;
    let createdUrls: string[] = [];
    setObjectUrls([]);
    setPartIndex(0);
    setFailedForNonce(null);
    preparePlaybackObjectUrls(summary.id, summary.outputMediaType)
      .then((urls) => {
        if (cancelled) {
          for (const url of urls) {
            URL.revokeObjectURL(url);
          }
          return;
        }
        createdUrls = urls;
        setObjectUrls(urls);
      })
      .catch(() => {
        if (!cancelled) {
          setFailedForNonce(retryNonce);
        }
      });
    return () => {
      cancelled = true;
      for (const url of createdUrls) {
        URL.revokeObjectURL(url);
      }
    };
  }, [retryNonce, summary.id, summary.outputMediaType]);

  let media: React.JSX.Element;
  if (playbackFailed) {
    media = (
      <div className="grid gap-4">
        <p className="text-sm text-white/80">{UNAVAILABLE_MESSAGE}</p>
        <Button
          className={`${actionClassName} w-fit`}
          onClick={onRetryPlayback}
          type="button"
        >
          Try playback again
        </Button>
      </div>
    );
  } else if (activeUrl) {
    media = (
      <div className="grid gap-3">
        {/* biome-ignore lint/a11y/useMediaCaption: this public POC has no transcript source. */}
        <video
          aria-label="Recording playback"
          className="aspect-video w-full rounded-xl bg-black"
          controls
          key={`${retryNonce}-${partIndex}`}
          onEnded={handlePartEnded}
          onError={handleMediaError}
          preload="auto"
          src={activeUrl}
        />
        {objectUrls.length > 1 ? (
          <div className="flex flex-wrap items-center gap-3">
            <p className="text-sm text-white/70">
              Part {partIndex + 1} of {objectUrls.length}
            </p>
            <Button
              className={`${actionClassName} w-fit`}
              disabled={partIndex === 0}
              onClick={handlePreviousPart}
              type="button"
            >
              Previous part
            </Button>
            <Button
              className={`${actionClassName} w-fit`}
              disabled={partIndex + 1 >= objectUrls.length}
              onClick={handleNextPart}
              type="button"
            >
              Next part
            </Button>
          </div>
        ) : null}
      </div>
    );
  } else {
    media = <p className="text-sm text-white/70">Preparing playback.</p>;
  }

  return (
    <div className="grid gap-6">
      {media}
      <div className="grid gap-1.5">
        <time
          className="text-sm text-white/80"
          dateTime={new Date(summary.createdAt).toISOString()}
        >
          {formatCreatedAt(summary.createdAt)}
        </time>
        <p className="text-sm text-white/70">
          {playbackStatusLabel(summary.status)}
        </p>
        <RecordingOutputMeta summary={summary} />
      </div>
    </div>
  );
}

export function RecordingPlaybackDetail(
  props: RecordingPlaybackDetailProps
): React.JSX.Element {
  const detailKind = props.summary
    ? playbackDetailKind(props.summary)
    : "unavailable";

  return (
    <main className="min-h-dvh bg-black text-white">
      <div className="mx-auto flex max-w-4xl flex-col gap-8 px-4 py-8 sm:px-8 sm:py-12">
        <h1 className="font-semibold text-4xl leading-tight sm:text-5xl">
          Recording playback
        </h1>
        {props.lookupKind === "loading" ? (
          <p className="text-sm text-white/70">Loading recording.</p>
        ) : null}
        {props.lookupKind === "missing" ? (
          <div className="grid gap-6">
            <p className="text-sm text-white/80">{UNAVAILABLE_MESSAGE}</p>
            <DetailReturnLink />
          </div>
        ) : null}
        {props.lookupKind === "error" ? (
          <div className="grid gap-4">
            <p className="text-sm text-white/80">{LOOKUP_ERROR_MESSAGE}</p>
            <Button
              className={`${actionClassName} w-fit`}
              onClick={props.onRetryLookup}
              type="button"
            >
              Try again
            </Button>
          </div>
        ) : null}
        {props.lookupKind === "found" && props.summary ? (
          <div className="grid gap-8">
            {detailKind === "processing" ? (
              <p className="text-sm text-white/80">{PROCESSING_MESSAGE}</p>
            ) : null}
            {detailKind === "unavailable" ? (
              <p className="text-sm text-white/80">{UNAVAILABLE_MESSAGE}</p>
            ) : null}
            {detailKind === "playable" ? (
              <PlayableRecording
                mediaFailed={props.mediaFailed}
                onRetryPlayback={props.onRetryPlayback}
                retryNonce={props.retryNonce}
                summary={props.summary}
              />
            ) : null}
            <DetailReturnLink />
          </div>
        ) : null}
      </div>
    </main>
  );
}
