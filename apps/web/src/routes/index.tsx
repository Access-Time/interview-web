import { useMutation } from "@tanstack/react-query";
import { createFileRoute } from "@tanstack/react-router";
import { useEffect, useState } from "react";
import {
  CandidateRecordingJourney,
  RECORDING_DELIVERY_COPY,
} from "@/recording/candidate-recording-journey";
import {
  type RecordingDeliveryPhase,
  type RecordingFinalizationState,
  type RecordingJourneyOutcome,
  type RecordingManifestLookup,
  type RecordingManifestView,
  type RecordingPreflightState,
  type RecordingSaveState,
  type RecordingStopReason,
  type UseLiveRecordingResult,
  useLiveRecording,
} from "@/recording/live-recording";
import { useRecordingApi } from "@/recording/recording-api";
import type { ApiErrors } from "@/utils/orpc";
import { isRecordingNotFoundError } from "@/utils/recording-errors";

export const Route = createFileRoute("/")({
  component: HomeComponent,
  head: () => ({ meta: [{ title: "Video introduction" }] }),
});

type PendingAction =
  | "initialize"
  | "retry"
  | "retry-preflight"
  | "start"
  | "stop";

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

export function recordingManifestLookup(
  getManifest: (input: { sessionId: string }) => Promise<RecordingManifestView>,
  input: { sessionId: string }
): Promise<RecordingManifestLookup> {
  return getManifest(input).then(
    (manifest) => ({ kind: "found", manifest }),
    (error: ApiErrors["recording"]["getManifest"]) => {
      if (isRecordingNotFoundError(error)) {
        return { kind: "missing" };
      }
      throw error;
    }
  );
}

function mapDeliveryHandoff(input: {
  finalizationState?: RecordingFinalizationState | "idle";
  hasIncompleteRecordingFinalization?: boolean;
  hasUnsentRecordingMedia?: boolean;
  recordingDeliveryPhase?: RecordingDeliveryPhase;
  recordingPreflightState?: RecordingPreflightState;
  recordingStopReason?: RecordingStopReason;
}) {
  if (input.recordingPreflightState === "blocked") {
    return {
      blockingError: RECORDING_DELIVERY_COPY.preflightBlocked,
      blockingErrorTitle: "This device isn’t ready to record",
      deliveryMessage: null,
    };
  }
  if (input.recordingStopReason === "save-failure") {
    return {
      blockingError: RECORDING_DELIVERY_COPY.saveFailure,
      blockingErrorTitle: "Recording needs attention",
      deliveryMessage: null,
    };
  }
  if (input.recordingStopReason === "capacity") {
    return {
      blockingError: null,
      blockingErrorTitle: null,
      deliveryMessage: RECORDING_DELIVERY_COPY.capacity,
    };
  }
  if (
    input.recordingStopReason === "candidate" &&
    input.hasUnsentRecordingMedia
  ) {
    return {
      blockingError: null,
      blockingErrorTitle: null,
      deliveryMessage: RECORDING_DELIVERY_COPY.candidateStop,
    };
  }
  if (
    input.hasIncompleteRecordingFinalization ||
    input.finalizationState === "queued" ||
    input.finalizationState === "finalizing"
  ) {
    return {
      blockingError: null,
      blockingErrorTitle: null,
      deliveryMessage: RECORDING_DELIVERY_COPY.completionPending,
    };
  }
  if (input.recordingPreflightState === "checking") {
    return {
      blockingError: null,
      blockingErrorTitle: null,
      deliveryMessage: RECORDING_DELIVERY_COPY.checking,
    };
  }
  if (
    input.recordingPreflightState === "ready" &&
    (input.recordingDeliveryPhase ?? "idle") === "idle"
  ) {
    return {
      blockingError: null,
      blockingErrorTitle: null,
      deliveryMessage: RECORDING_DELIVERY_COPY.ready,
    };
  }
  const phaseCopy = {
    idle: null,
    offline: RECORDING_DELIVERY_COPY.offline,
    reconnecting: RECORDING_DELIVERY_COPY.reconnecting,
    retrying: RECORDING_DELIVERY_COPY.retrying,
    saving: RECORDING_DELIVERY_COPY.saving,
  } as const;
  return {
    blockingError: null,
    blockingErrorTitle: null,
    deliveryMessage: phaseCopy[input.recordingDeliveryPhase ?? "idle"],
  };
}

export function candidateJourneyHandoff(input: {
  actionError?: CandidateError | null;
  captureEnded?: boolean;
  controlsHasStopped?: boolean;
  finalizationState?: RecordingFinalizationState | "idle";
  hasIncompleteRecordingFinalization?: boolean;
  hasUnsentRecordingMedia?: boolean;
  journeyOutcome?: RecordingJourneyOutcome;
  recordingDeliveryPhase?: RecordingDeliveryPhase;
  recordingError?: string | null;
  recordingPreflightState?: RecordingPreflightState;
  recordingStopReason?: RecordingStopReason;
  saveState?: RecordingSaveState;
}) {
  const recordingError = input.recordingError
    ? usefulError(input.recordingError)
    : null;
  const visibleError = input.actionError ?? recordingError;
  const delivery = mapDeliveryHandoff(input);
  const fallbackBlocking =
    input.journeyOutcome === "none" && input.finalizationState !== "failed"
      ? visibleError
      : null;
  const blockingError =
    delivery.blockingError ?? fallbackBlocking?.message ?? null;
  const blockingErrorTitle =
    delivery.blockingErrorTitle ??
    (blockingError ? (visibleError?.title ?? null) : null);
  const { deliveryMessage } = delivery;

  return {
    blockingError,
    blockingErrorTitle,
    captureBlocked: Boolean(
      input.actionError?.captureBlocked || recordingError?.captureBlocked
    ),
    deliveryMessage,
    finalizationState: input.finalizationState ?? "idle",
    hasStopped: Boolean(
      input.captureEnded ||
        input.controlsHasStopped ||
        (input.finalizationState && input.finalizationState !== "idle")
    ),
    journeyOutcome: input.journeyOutcome ?? "none",
    savingNotice: resolveSavingNotice(
      deliveryMessage,
      input.journeyOutcome,
      input.saveState
    ),
  };
}

function resolveSavingNotice(
  deliveryMessage: string | null,
  journeyOutcome?: RecordingJourneyOutcome,
  saveState?: RecordingSaveState
) {
  if (deliveryMessage) {
    return deliveryMessage;
  }
  if (journeyOutcome !== "automatic-retry") {
    return null;
  }
  return saveState === "offline"
    ? "Saving will resume when you reconnect."
    : "Keep this screen open; we’ll keep trying.";
}

export function shouldWarnBeforeUnload(input: {
  hasIncompleteRecordingFinalization: boolean;
  hasUnsentRecordingMedia: boolean;
  recording: boolean;
}) {
  return (
    input.recording ||
    input.hasUnsentRecordingMedia ||
    input.hasIncompleteRecordingFinalization
  );
}

function useRecordingControls(recording: UseLiveRecordingResult) {
  const [actionError, setActionError] = useState<CandidateError | null>(null);
  const [hasStopped, setHasStopped] = useState(false);

  const initialize = useMutation({
    mutationFn: recording.initialize,
    onError: (error) => setActionError(usefulError(error)),
    onMutate: () => setActionError(null),
  });
  const start = useMutation({
    mutationFn: recording.start,
    onError: (error) => setActionError(usefulError(error)),
    onMutate: () => setActionError(null),
  });
  const stop = useMutation({
    mutationFn: recording.stop,
    onError: (error) => setActionError(usefulError(error)),
    onMutate: () => setActionError(null),
    onSuccess: () => setHasStopped(true),
  });
  const retry = useMutation({
    mutationFn: recording.retryFinalization,
    onError: (error) => setActionError(usefulError(error)),
    onMutate: () => setActionError(null),
  });
  const retryPreflight = useMutation({
    mutationFn: recording.retryRecordingPreflight,
    onError: (error) => setActionError(usefulError(error)),
    onMutate: () => setActionError(null),
  });
  const resetRecovered = useMutation({
    mutationFn: recording.resetRecoveredRecording,
  });

  let pendingAction: PendingAction | null = null;
  if (initialize.isPending) {
    pendingAction = "initialize";
  } else if (start.isPending) {
    pendingAction = "start";
  } else if (stop.isPending) {
    pendingAction = "stop";
  } else if (retry.isPending) {
    pendingAction = "retry";
  } else if (retryPreflight.isPending) {
    pendingAction = "retry-preflight";
  }

  return {
    actionError,
    handleInitialize: initialize.mutate,
    handleRetryFinalization: retry.mutate,
    handleRetryPreflight: retryPreflight.mutate,
    handleStart: start.mutate,
    handleStop: stop.mutate,
    hasStopped,
    pendingAction,
    resetRecovered: resetRecovered.mutate,
  };
}

function HomeComponent() {
  const [manifestSessionId, setManifestSessionId] = useState<string | null>(
    null
  );
  const [statusSessionId, setStatusSessionId] = useState<string | null>(null);
  const api = useRecordingApi({ manifestSessionId, statusSessionId });
  const recording = useLiveRecording({
    appendSegment: api.appendSegment,
    createSession: api.createSession,
    finalizeSession: api.finalizeSession,
    manifestLookup: api.manifestLookup,
    onRequestManifest: setManifestSessionId,
    onRequestStatus: setStatusSessionId,
    status: api.status,
  });
  const controls = useRecordingControls(recording);
  const finalizationState = recording.finalization?.state ?? "idle";
  const handoff = candidateJourneyHandoff({
    actionError: controls.actionError,
    captureEnded: recording.captureEnded,
    controlsHasStopped: controls.hasStopped,
    finalizationState,
    hasIncompleteRecordingFinalization:
      recording.hasIncompleteRecordingFinalization,
    hasUnsentRecordingMedia: recording.hasUnsentRecordingMedia,
    journeyOutcome: recording.journeyOutcome,
    recordingDeliveryPhase: recording.recordingDeliveryPhase,
    recordingError: recording.error,
    recordingPreflightState: recording.recordingPreflightState,
    recordingStopReason: recording.recordingStopReason,
    saveState: recording.saveState,
  });
  const warnBeforeUnload = shouldWarnBeforeUnload({
    hasIncompleteRecordingFinalization:
      recording.hasIncompleteRecordingFinalization,
    hasUnsentRecordingMedia: recording.hasUnsentRecordingMedia,
    recording: recording.isRecording,
  });

  useEffect(() => {
    if (!warnBeforeUnload) {
      return;
    }
    const warnPending = (event: BeforeUnloadEvent) => {
      event.preventDefault();
      event.returnValue = "";
    };
    window.addEventListener("beforeunload", warnPending);
    return () => window.removeEventListener("beforeunload", warnPending);
  }, [warnBeforeUnload]);

  return (
    <CandidateRecordingJourney
      blockingError={handoff.blockingError}
      blockingErrorTitle={handoff.blockingErrorTitle}
      captureBlocked={handoff.captureBlocked}
      finalization={recording.finalization}
      hasIncompleteRecordingFinalization={
        recording.hasIncompleteRecordingFinalization
      }
      hasStopped={handoff.hasStopped}
      hasUnsentRecordingMedia={recording.hasUnsentRecordingMedia}
      isReady={recording.isReady}
      isRecording={recording.isRecording}
      journeyOutcome={handoff.journeyOutcome}
      onInitialize={controls.handleInitialize}
      onResetRecoveredRecording={
        recording.canResetRecoveredRecording
          ? controls.resetRecovered
          : undefined
      }
      onRetry={controls.handleRetryFinalization}
      onRetryPreflight={controls.handleRetryPreflight}
      onStart={controls.handleStart}
      onStop={controls.handleStop}
      pendingAction={controls.pendingAction}
      recordingDeliveryPhase={recording.recordingDeliveryPhase}
      recordingPreflightState={recording.recordingPreflightState}
      recordingStopReason={recording.recordingStopReason}
      recovered={recording.recovered}
      saveState={recording.saveState}
      savingNotice={handoff.savingNotice}
      stream={recording.stream}
    />
  );
}
