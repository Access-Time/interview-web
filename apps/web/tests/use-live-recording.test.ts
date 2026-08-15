import { act, renderHook, waitFor } from "@testing-library/react";
import { expect, it, vi } from "vitest";
import { useLiveRecording } from "../src/recording/live-recording";

const options = () => ({
  appendSegment: vi.fn(),
  createSession: vi.fn(),
  finalizeSession: vi.fn(),
});

it("reports a preflight access error without delivery state", async () => {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      getUserMedia: vi.fn(() => Promise.reject(new Error("permission denied"))),
    },
  });
  const { result } = renderHook(() => useLiveRecording(options()));
  await act(async () => {
    await result.current.initialize();
  });
  await waitFor(() =>
    expect(result.current.error).toContain("permission denied")
  );
  expect("recordingDeliveryPhase" in result.current).toBe(false);
});

it("keeps the capacity, completion, retry, and local-save journeys public", () => {
  const { result } = renderHook(() => useLiveRecording(options()));
  expect(result.current.hasUnsentRecordingMedia).toBe(false);
  expect(result.current.retryFinalization).toEqual(expect.any(Function));
  expect(result.current.stop).toEqual(expect.any(Function));
  expect(result.current.saveState).toBe("healthy");
});

it("exposes no public pending-byte or integrity state", () => {
  const { result } = renderHook(() => useLiveRecording(options()));
  expect("pendingPartCount" in result.current).toBe(false);
  expect("integrity" in result.current).toBe(false);
});
