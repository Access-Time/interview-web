import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CandidateRecordingJourney } from "@/recording/candidate-recording-journey";
import {
  type RecordingFinalizationState,
  type RecordingJourneyOutcome,
  type RecordingManifestLookup,
  type RecordingManifestView,
  type RecordingSaveState,
  type UseLiveRecordingResult,
  useLiveRecording,
} from "@/recording/live-recording";
import { client } from "@/utils/orpc";
import { isRecordingNotFoundError } from "@/utils/recording-errors";

export const Route = createFileRoute("/")({
  component: HomeComponent,
  head: () => ({ meta: [{ title: "Video introduction" }] }),
});

type PendingAction = "initialize" | "retry" | "start" | "stop";

const PERMISSION_ERROR = /permission|notallowed|denied|security/;
const DEVICE_ERROR = /notfound|device|camera|microphone|media/;
const STORAGE_ERROR = /storage|quota|indexeddb|store/;
const INTEGRITY_ERROR = /conflicting parts|missing ordered parts/;

interface CandidateError {
  captureBlocked: boolean;
  message: string;
  title: string;
}

export function usefulError(error: unknown): CandidateError {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();

  if (PERMISSION_ERROR.test(normalized)) {
    return {
      captureBlocked: false,
      message:
        "Camera and microphone access was blocked. Allow both in your browser settings, then try again.",
      title: "Camera and microphone access blocked",
    };
  }
  if (DEVICE_ERROR.test(normalized)) {
    return {
      captureBlocked: false,
      message:
        "We couldn’t connect to both a camera and microphone. Check that they’re plugged in and not in use by another app.",
      title: "Camera or microphone unavailable",
    };
  }
  if (STORAGE_ERROR.test(normalized)) {
    return {
      captureBlocked: true,
      message:
        "This browser can’t save your recording safely right now. Free up space on your device, then try again.",
      title: "Recording can’t be saved",
    };
  }
  if (INTEGRITY_ERROR.test(normalized)) {
    return {
      captureBlocked: true,
      message:
        "We found a problem with your recording that needs attention. Keep this tab open and try again.",
      title: "Recording needs attention",
    };
  }
  return {
    captureBlocked: false,
    message:
      "Something went wrong with the recording. Keep this page open and try the action again.",
    title: "Recording needs attention",
  };
}

export async function recordingManifestLookup(
  getManifest: (input: { sessionId: string }) => Promise<RecordingManifestView>,
  input: { sessionId: string }
): Promise<RecordingManifestLookup> {
  try {
    return {
      kind: "found",
      manifest: await getManifest(input),
    };
  } catch (error) {
    if (isRecordingNotFoundError(error)) {
      return { kind: "missing" };
    }
    throw error;
  }
}

export function candidateJourneyHandoff(input: {
  actionError: CandidateError | null;
  captureEnded: boolean;
  controlsHasStopped: boolean;
  finalizationState: RecordingFinalizationState | "idle";
  journeyOutcome: RecordingJourneyOutcome;
  recordingError: string | null;
  saveState: RecordingSaveState;
}) {
  const recordingError = input.recordingError
    ? usefulError(input.recordingError)
    : null;
  const visibleError = input.actionError ?? recordingError;
  const blockingError =
    input.journeyOutcome === "none" && input.finalizationState !== "failed"
      ? (visibleError?.message ?? null)
      : null;
  let savingNotice: string | null = null;
  if (input.journeyOutcome === "automatic-retry") {
    savingNotice =
      input.saveState === "offline"
        ? "Saving will resume when you reconnect."
        : "Keep this screen open; we’ll keep trying.";
  }

  return {
    blockingError,
    blockingErrorTitle: blockingError ? (visibleError?.title ?? null) : null,
    captureBlocked: Boolean(
      input.actionError?.captureBlocked || recordingError?.captureBlocked
    ),
    finalizationState: input.finalizationState,
    hasStopped:
      input.captureEnded ||
      input.controlsHasStopped ||
      input.finalizationState !== "idle",
    journeyOutcome: input.journeyOutcome,
    savingNotice,
  };
}

function useRecordingControls(recording: UseLiveRecordingResult) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );
  const [actionError, setActionError] = useState<CandidateError | null>(null);
  const [hasStopped, setHasStopped] = useState(false);
  const { initialize, retryFinalization, start, stop } = recording;

  const perform = useCallback(
    async (action: PendingAction, task: () => Promise<void>) => {
      setPendingAction(action);
      setActionError(null);
      try {
        await task();
      } catch (cause) {
        setActionError(usefulError(cause));
      } finally {
        setPendingAction(null);
      }
    },
    []
  );

  const handleInitialize = useCallback(() => {
    perform("initialize", initialize).catch(() => undefined);
  }, [initialize, perform]);

  const handleStart = useCallback(() => {
    perform("start", start).catch(() => undefined);
  }, [perform, start]);

  const handleStop = useCallback(() => {
    const stopAndMark = async () => {
      await stop();
      setHasStopped(true);
    };
    perform("stop", stopAndMark).catch(() => undefined);
  }, [perform, stop]);

  const handleRetryFinalization = useCallback(() => {
    perform("retry", retryFinalization).catch(() => undefined);
  }, [perform, retryFinalization]);

  return {
    actionError,
    handleInitialize,
    handleRetryFinalization,
    handleStart,
    handleStop,
    hasStopped,
    pendingAction,
  };
}

function HomeComponent() {
  const recording = useLiveRecording({
    appendSegment: (input) => client.recording.appendSegment(input),
    createSession: (input) => client.recording.create(input),
    finalizeSession: (input) => client.recording.finalize(input),
    getFinalizationStatus: (input) => client.recording.getStatus(input),
    getManifest: (input) =>
      recordingManifestLookup(client.recording.getManifest, input),
  });
  const controls = useRecordingControls(recording);
  const finalizationState = recording.finalization?.state ?? "idle";
  const handoff = candidateJourneyHandoff({
    actionError: controls.actionError,
    captureEnded: recording.captureEnded,
    controlsHasStopped: controls.hasStopped,
    finalizationState,
    journeyOutcome: recording.journeyOutcome,
    recordingError: recording.error,
    saveState: recording.saveState,
  });

  useEffect(() => {
    if (recording.pendingPartCount === 0) {
      return;
    }
    const warnPending = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnPending);
    return () => window.removeEventListener("beforeunload", warnPending);
  }, [recording.pendingPartCount]);

  return (
    <CandidateRecordingJourney
      blockingError={handoff.blockingError}
      blockingErrorTitle={handoff.blockingErrorTitle}
      captureBlocked={handoff.captureBlocked}
      finalization={recording.finalization}
      hasStopped={handoff.hasStopped}
      isReady={recording.isReady}
      isRecording={recording.isRecording}
      journeyOutcome={handoff.journeyOutcome}
      onInitialize={controls.handleInitialize}
      onResetRecoveredRecording={
        recording.canResetRecoveredRecording
          ? () => {
              recording.resetRecoveredRecording().catch(() => undefined);
            }
          : undefined
      }
      onRetry={controls.handleRetryFinalization}
      onStart={controls.handleStart}
      onStop={controls.handleStop}
      pendingAction={controls.pendingAction}
      recovered={recording.recovered}
      saveState={recording.saveState}
      savingNotice={handoff.savingNotice}
      stream={recording.stream}
    />
  );
}
