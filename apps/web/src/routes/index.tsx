import { createFileRoute } from "@tanstack/react-router";
import { useCallback, useEffect, useState } from "react";
import { CandidateRecordingJourney } from "@/recording/candidate-recording-journey";
import {
  type RecordingSaveState,
  type UseLiveRecordingResult,
  useLiveRecording,
} from "@/recording/live-recording";
import { client } from "@/utils/orpc";

export const Route = createFileRoute("/")({
  component: HomeComponent,
  head: () => ({ meta: [{ title: "Video introduction" }] }),
});

type PendingAction = "initialize" | "retry" | "start" | "stop";

const PERMISSION_ERROR = /permission|notallowed|denied|security/;
const DEVICE_ERROR = /notfound|device|camera|microphone|media/;
const STORAGE_ERROR = /storage|quota|indexeddb|store/;
const NETWORK_ERROR = /network|fetch|upload|offline|connection/;
const INTEGRITY_ERROR = /conflicting parts|missing ordered parts/;

const NETWORK_GUIDANCE: Record<RecordingSaveState, string> = {
  error:
    "Saving needs attention. Keep this tab open and check your connection.",
  healthy:
    "Saving needs attention. Keep this tab open and check your connection.",
  offline:
    "You’re offline. Keep this tab open; we’ll continue when your connection returns.",
  retrying: "Saving is delayed. Keep this tab open while we try again.",
};

function usefulError(
  error: unknown,
  saveState: RecordingSaveState = "healthy"
) {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();

  if (PERMISSION_ERROR.test(normalized)) {
    return "Camera and microphone access was blocked. Allow both in your browser settings, then try again.";
  }
  if (DEVICE_ERROR.test(normalized)) {
    return "We couldn’t connect to both a camera and microphone. Check that they’re plugged in and not in use by another app.";
  }
  if (STORAGE_ERROR.test(normalized)) {
    return "This browser can’t save your recording safely right now. Free up space on your device, then try again.";
  }
  if (NETWORK_ERROR.test(normalized)) {
    return NETWORK_GUIDANCE[saveState];
  }
  if (INTEGRITY_ERROR.test(normalized)) {
    return "We found a problem with your recording that needs attention. Keep this tab open and try again.";
  }
  return "Something went wrong with the recording. Keep this page open and try the action again.";
}

function useRecordingControls(recording: UseLiveRecordingResult) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);
  const [hasStopped, setHasStopped] = useState(false);
  const { initialize, retryFinalization, saveState, start, stop } = recording;

  const perform = useCallback(
    async (action: PendingAction, task: () => Promise<void>) => {
      setPendingAction(action);
      setActionError(null);
      try {
        await task();
      } catch (cause) {
        setActionError(usefulError(cause, saveState));
      } finally {
        setPendingAction(null);
      }
    },
    [saveState]
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
    getManifest: async (input) => {
      try {
        return await client.recording.getManifest(input);
      } catch {
        return null;
      }
    },
  });
  const controls = useRecordingControls(recording);
  const finalizationState = recording.finalization?.state ?? "idle";
  const hasStopped = controls.hasStopped || finalizationState !== "idle";
  const blockingError =
    finalizationState === "failed"
      ? null
      : (controls.actionError ??
        (recording.error
          ? usefulError(recording.error, recording.saveState)
          : null));

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
      blockingError={blockingError}
      finalization={recording.finalization}
      hasStopped={hasStopped}
      isReady={recording.isReady}
      isRecording={recording.isRecording}
      onInitialize={controls.handleInitialize}
      onRetry={controls.handleRetryFinalization}
      onStart={controls.handleStart}
      onStop={controls.handleStop}
      pendingAction={controls.pendingAction}
      recovered={recording.recovered}
      saveState={recording.saveState}
      stream={recording.stream}
    />
  );
}
