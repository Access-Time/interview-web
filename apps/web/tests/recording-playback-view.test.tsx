import type { RecordingPlaybackSummary } from "@interview-web/db";
import { fireEvent, render, screen } from "@testing-library/react";
import React from "react";
import { expect, it, vi } from "vitest";
import {
  RecordingPlaybackDetail,
  RecordingPlaybackList,
} from "../src/recording/playback-view";

vi.mock("@tanstack/react-router", () => ({
  Link: ({
    children,
    params,
    to,
  }: {
    children: React.ReactNode;
    params?: { sessionId?: string };
    to: string;
  }) =>
    React.createElement(
      "a",
      {
        href: params?.sessionId
          ? `/operator/recordings/${params.sessionId}`
          : to,
      },
      children
    ),
}));

const noop = () => undefined;

const readySummary: RecordingPlaybackSummary = {
  createdAt: 1_725_000_000_000,
  hasOutput: true,
  id: "session-1",
  outputByteSize: 1024,
  outputMediaType: "video/webm",
  status: "ready",
};

const processingSummary: RecordingPlaybackSummary = {
  ...readySummary,
  hasOutput: false,
  id: "session-processing",
  outputByteSize: null,
  outputMediaType: null,
  status: "finalizing",
};

function assertNoSensitiveDetails(root: HTMLElement) {
  const text = root.textContent ?? "";
  expect(text).not.toContain("session-1");
  expect(text).not.toContain("session-processing");
  expect(text).not.toContain("outputObjectKey");
  expect(text).not.toContain("recordings/session-1/output.webm");
  expect(text).not.toContain("outputChecksum");
  expect(text).not.toContain("deadbeef");
  expect(text).not.toContain("failureCode");
  expect(text).not.toContain("mux_failed");
}

it("renders semantic list landmarks, a ready link, and load more", () => {
  const { container } = render(
    <RecordingPlaybackList
      errorKind={null}
      isLoading={false}
      isLoadingMore={false}
      items={[readySummary]}
      nextCursor={{ createdAt: 1, id: "older" }}
      onLoadMore={noop}
      onRetry={noop}
    />
  );

  expect(screen.getByRole("main")).toBeTruthy();
  expect(screen.getByRole("heading", { name: "Recordings" })).toBeTruthy();
  expect(screen.getByRole("list")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Play recording" })).toBeTruthy();
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
  assertNoSensitiveDetails(container);
});

it("shows a concise initial loading status", () => {
  render(
    <RecordingPlaybackList
      errorKind={null}
      isLoading={true}
      isLoadingMore={false}
      items={[]}
      nextCursor={null}
      onLoadMore={noop}
      onRetry={noop}
    />
  );

  expect(screen.getByText("Loading recordings.")).toBeTruthy();
  expect(screen.queryByRole("list")).toBeNull();
});

it("shows an empty first page without a load more control", () => {
  render(
    <RecordingPlaybackList
      errorKind={null}
      isLoading={false}
      isLoadingMore={false}
      items={[]}
      nextCursor={null}
      onLoadMore={noop}
      onRetry={noop}
    />
  );

  expect(screen.getByText("No recordings yet.")).toBeTruthy();
  expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
});

it("shows a retryable initial error without leaking details", () => {
  const onRetry = vi.fn();
  const { container } = render(
    <RecordingPlaybackList
      errorKind="initial"
      isLoading={false}
      isLoadingMore={false}
      items={[]}
      nextCursor={null}
      onLoadMore={noop}
      onRetry={onRetry}
    />
  );

  expect(
    screen.getByText("We couldn't load recordings. Try again.")
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try again" }));
  expect(onRetry).toHaveBeenCalledTimes(1);
  assertNoSensitiveDetails(container);
});

it("keeps loaded rows visible when a later page fails", () => {
  render(
    <RecordingPlaybackList
      errorKind="load-more"
      isLoading={false}
      isLoadingMore={false}
      items={[readySummary]}
      nextCursor={{ createdAt: 1, id: "older" }}
      onLoadMore={noop}
      onRetry={noop}
    />
  );

  expect(screen.getByRole("link", { name: "Play recording" })).toBeTruthy();
  expect(
    screen.getByText("We couldn't load recordings. Try again.")
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Load more" })).toBeTruthy();
});

it("labels a processing row as view status", () => {
  render(
    <RecordingPlaybackList
      errorKind={null}
      isLoading={false}
      isLoadingMore={false}
      items={[processingSummary]}
      nextCursor={null}
      onLoadMore={noop}
      onRetry={noop}
    />
  );

  expect(screen.getByRole("link", { name: "View status" })).toBeTruthy();
  expect(screen.queryByRole("link", { name: "Play recording" })).toBeNull();
});

it("plays a ready recording with native controls and retries media failure", async () => {
  const retryPlayback = vi.fn();
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue({
      arrayBuffer: async () => new Uint8Array([1, 2, 3]).buffer,
      ok: true,
    })
  );
  const { container } = render(
    <RecordingPlaybackDetail
      lookupKind="found"
      mediaFailed={false}
      onRetryLookup={noop}
      onRetryPlayback={retryPlayback}
      retryNonce={0}
      summary={readySummary}
    />
  );

  const video = await screen.findByLabelText("Recording playback");
  expect(video.getAttribute("controls")).not.toBeNull();
  fireEvent.error(video);
  expect(screen.getByText("Recording unavailable")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Try playback again" }));
  expect(retryPlayback).toHaveBeenCalledTimes(1);
  assertNoSensitiveDetails(container);
  vi.unstubAllGlobals();
});

it("does not render a player while a recording is still processing", () => {
  render(
    <RecordingPlaybackDetail
      lookupKind="found"
      mediaFailed={false}
      onRetryLookup={noop}
      onRetryPlayback={noop}
      retryNonce={0}
      summary={processingSummary}
    />
  );

  expect(
    screen.getByText("This recording is still being prepared.")
  ).toBeTruthy();
  expect(screen.queryByLabelText("Recording playback")).toBeNull();
});

it("shows a missing recording with a return link", () => {
  const { container } = render(
    <RecordingPlaybackDetail
      lookupKind="missing"
      mediaFailed={false}
      onRetryLookup={noop}
      onRetryPlayback={noop}
      retryNonce={0}
      summary={null}
    />
  );

  expect(screen.getByText("Recording unavailable")).toBeTruthy();
  expect(screen.getByRole("link", { name: "Back to recordings" })).toBeTruthy();
  assertNoSensitiveDetails(container);
});
