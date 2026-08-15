import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { useEffect, useRef } from "react";
import type {
  RecordingDeliveryPhase,
  RecordingFinalizationResult,
  RecordingJourneyOutcome,
  RecordingPreflightState,
  RecordingSaveState,
  RecordingStopReason,
} from "./live-recording";

// biome-ignore lint: preserve the approved public type-alias contract.
export type CandidateRecordingJourneyProps = {
  blockingError: string | null;
  blockingErrorTitle: string | null;
  captureBlocked: boolean;
  finalization: RecordingFinalizationResult | null;
  hasIncompleteRecordingFinalization: boolean;
  hasStopped: boolean;
  hasUnsentRecordingMedia: boolean;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  onInitialize: () => void;
  onRetry: () => void;
  onRetryPreflight: () => void;
  onResetRecoveredRecording?: () => void;
  onStart: () => void;
  onStop: () => void;
  pendingAction:
    | "initialize"
    | "retry"
    | "retry-preflight"
    | "start"
    | "stop"
    | null;
  recordingDeliveryPhase: RecordingDeliveryPhase;
  recordingPreflightState: RecordingPreflightState;
  recordingStopReason: RecordingStopReason;
  recovered: boolean;
  saveState: RecordingSaveState;
  savingNotice: string | null;
  stream: MediaStream | null;
};

type JourneyState =
  | "permission"
  | "ready"
  | "recovered"
  | "recording"
  | "submitting"
  | "manual-retry"
  | "terminal-restart"
  | "missing-recovery"
  | "success";

function journeyState(props: CandidateRecordingJourneyProps): JourneyState {
  if (props.finalization?.state === "ready") {
    return "success";
  }
  if (props.journeyOutcome === "missing-recovery") {
    return "missing-recovery";
  }
  if (props.journeyOutcome === "terminal-restart") {
    return "terminal-restart";
  }
  if (props.journeyOutcome === "manual-retry") {
    return "manual-retry";
  }
  if (
    props.journeyOutcome === "automatic-retry" ||
    props.hasStopped ||
    props.finalization?.state === "queued" ||
    props.finalization?.state === "finalizing"
  ) {
    return "submitting";
  }
  if (props.isRecording) {
    return "recording";
  }
  if (props.recovered) {
    return "recovered";
  }
  if (props.isReady) {
    return "ready";
  }
  return "permission";
}

function CameraStage({ stream }: { stream: MediaStream | null }) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: React populates the video ref after render.
    if (video) {
      video.srcObject = stream;
    }
    return () => {
      if (video?.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="mt-8 aspect-video overflow-hidden rounded-xl border border-white/15 bg-black sm:mt-10">
      {stream ? (
        <video
          aria-label="Your camera preview"
          autoPlay
          className="h-full w-full object-cover [transform:scaleX(-1)]"
          muted
          playsInline
          ref={videoRef}
        />
      ) : (
        <div className="flex h-full items-center justify-center px-6 text-center text-sm text-white/60">
          Your preview will appear here
        </div>
      )}
    </div>
  );
}

export const RECORDING_DELIVERY_COPY = {
  candidateStop:
    "Your camera and microphone are off. Finishing your recording.",
  capacity:
    "We stopped recording to protect your saved recording. Finishing it now.",
  checking:
    "Checking that this device is ready to record for up to 30 minutes offline.",
  completionPending: "Your recording is saved. We’re completing it now.",
  finalizationFailure:
    "Your recording is still here, but we couldn’t finish it. Check your connection, then try again.",
  offline:
    "You’re offline. Your recording is still being saved on this device.",
  preflightBlocked:
    "This device isn’t ready to safely store a recording offline. Check your storage or browser, then try again.",
  ready:
    "This device is ready to protect up to 30 minutes of recording if you temporarily lose connection.",
  reconnecting: "Connection restored. Saving your recording.",
  retrying: "Connection trouble. We’ll keep trying.",
  saveFailure:
    "We couldn’t save this recording safely. Your camera and microphone are off. Contact the hiring team for help.",
  saving: "Your recording is being saved.",
} as const;

export interface RecordingDeliveryPresentationInput {
  finalization?: Pick<
    NonNullable<CandidateRecordingJourneyProps["finalization"]>,
    "state"
  > | null;
  hasIncompleteRecordingFinalization?: boolean;
  hasUnsentRecordingMedia?: boolean;
  isRecording?: boolean;
  recordingDeliveryPhase?: RecordingDeliveryPhase;
  recordingPreflightState?: RecordingPreflightState;
  recordingStopReason?: RecordingStopReason;
}

export function getDeliveryPresentation(
  props: RecordingDeliveryPresentationInput
): {
  kind: "alert" | "status" | null;
  message: string | null;
  retryPreflight: boolean;
} {
  if (props.recordingPreflightState === "blocked") {
    return {
      kind: "alert",
      message: RECORDING_DELIVERY_COPY.preflightBlocked,
      retryPreflight: true,
    };
  }
  if (props.recordingStopReason === "save-failure") {
    return {
      kind: "alert",
      message: RECORDING_DELIVERY_COPY.saveFailure,
      retryPreflight: false,
    };
  }
  if (props.finalization?.state === "failed") {
    return {
      kind: "alert",
      message: RECORDING_DELIVERY_COPY.finalizationFailure,
      retryPreflight: false,
    };
  }
  if (props.recordingStopReason === "capacity") {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.capacity,
      retryPreflight: false,
    };
  }
  if (
    props.recordingStopReason === "candidate" &&
    props.hasUnsentRecordingMedia
  ) {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.candidateStop,
      retryPreflight: false,
    };
  }
  if (
    props.hasIncompleteRecordingFinalization ||
    props.finalization?.state === "queued" ||
    props.finalization?.state === "finalizing"
  ) {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.completionPending,
      retryPreflight: false,
    };
  }
  if (props.recordingPreflightState === "checking") {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.checking,
      retryPreflight: false,
    };
  }
  if (
    props.recordingPreflightState === "ready" &&
    props.recordingDeliveryPhase === "idle" &&
    !props.isRecording
  ) {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.ready,
      retryPreflight: false,
    };
  }
  if (props.recordingDeliveryPhase === "saving") {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.saving,
      retryPreflight: false,
    };
  }
  if (props.recordingDeliveryPhase === "offline") {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.offline,
      retryPreflight: false,
    };
  }
  if (props.recordingDeliveryPhase === "reconnecting") {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.reconnecting,
      retryPreflight: false,
    };
  }
  if (props.recordingDeliveryPhase === "retrying") {
    return {
      kind: "status",
      message: RECORDING_DELIVERY_COPY.retrying,
      retryPreflight: false,
    };
  }
  return { kind: null, message: null, retryPreflight: false };
}

function getAsyncSavingMessage(props: CandidateRecordingJourneyProps): string {
  if (props.journeyOutcome === "manual-retry") {
    return "Your recording is still here. Check your connection, then try again.";
  }
  if (props.journeyOutcome !== "automatic-retry") {
    return "";
  }
  if (props.savingNotice) {
    return props.savingNotice;
  }
  return props.saveState === "offline"
    ? "Saving will resume when you reconnect."
    : "Keep this screen open; we’ll keep trying.";
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit finite journey states stay together for review.
function JourneyPanel(props: CandidateRecordingJourneyProps) {
  const delivery = getDeliveryPresentation(props);
  const state =
    props.recordingPreflightState === "blocked"
      ? "permission"
      : journeyState(props);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const submissionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const failureRef = useRef<HTMLHeadingElement | null>(null);
  const previous = useRef({ isReady: props.isReady, state });
  const asyncSavingMessage =
    state === "success" ? "" : getAsyncSavingMessage(props);

  useEffect(() => {
    const last = previous.current;
    if (
      !last.isReady &&
      props.isReady &&
      (state === "ready" || state === "recovered")
    ) {
      actionRef.current?.focus();
    } else if (
      (last.state === "ready" || last.state === "recovered") &&
      state === "recording"
    ) {
      actionRef.current?.focus();
    } else if (last.state === "recording" && state === "submitting") {
      submissionHeadingRef.current?.focus();
    } else if (
      (state === "manual-retry" ||
        state === "missing-recovery" ||
        state === "terminal-restart") &&
      last.state !== state
    ) {
      failureRef.current?.focus();
    }
    previous.current = { isReady: props.isReady, state };
  }, [props.isReady, state]);

  const actionsDisabled = props.pendingAction !== null;
  const actionClassName =
    "min-h-12 w-full rounded-lg !bg-black px-5 font-medium !text-white hover:!bg-neutral-800 focus-visible:ring-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline";
  let announcement = "";
  let content: React.JSX.Element;

  if (delivery.retryPreflight) {
    announcement = RECORDING_DELIVERY_COPY.preflightBlocked;
    content = (
      <>
        <h2
          className="font-semibold text-2xl leading-tight"
          id="journey-state-heading"
        >
          This device isn’t ready to record
        </h2>
        <div
          className="mt-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline"
          role="alert"
        >
          <Banner
            className="rounded-lg border border-neutral-200 bg-neutral-50 text-black"
            description={RECORDING_DELIVERY_COPY.preflightBlocked}
            icon={<span aria-hidden="true">!</span>}
            title="This device isn’t ready to record"
            variant="secondary"
          />
        </div>
        <Button
          className={`${actionClassName} mt-6`}
          disabled={actionsDisabled}
          onClick={props.onRetryPreflight}
          ref={actionRef}
          size="lg"
          type="button"
          variant="outline"
        >
          {props.pendingAction === "retry-preflight"
            ? "Checking this device…"
            : "Try again"}
        </Button>
      </>
    );
  } else if (state === "permission") {
    announcement = "Set up your camera and microphone.";
    content = (
      <>
        <h2
          className="font-semibold text-2xl leading-tight"
          id="journey-state-heading"
        >
          Set up your camera and microphone.
        </h2>
        <p className="mt-4 text-gray-600 leading-7">
          Nothing records until you choose Start recording.
        </p>
        <Button
          className={`${actionClassName} mt-8`}
          disabled={actionsDisabled}
          onClick={props.onInitialize}
          ref={actionRef}
          size="lg"
          type="button"
          variant="outline"
        >
          {props.pendingAction === "initialize"
            ? "Enabling camera and microphone…"
            : "Enable camera and microphone"}
        </Button>
      </>
    );
  } else if (state === "ready") {
    announcement = "You’re ready to record.";
    content = (
      <>
        <h2
          className="font-semibold text-2xl leading-tight"
          id="journey-state-heading"
        >
          You’re ready to record.
        </h2>
        <p className="mt-4 text-gray-600 leading-7">
          Recording begins only after you choose Start recording.
        </p>
        <Button
          className={`${actionClassName} mt-8`}
          disabled={actionsDisabled || (props.isReady && props.captureBlocked)}
          onClick={props.onStart}
          ref={actionRef}
          size="lg"
          type="button"
          variant="outline"
        >
          {props.pendingAction === "start"
            ? "Starting recording…"
            : "Start recording"}
        </Button>
      </>
    );
  } else if (state === "recovered") {
    announcement =
      "We found an unfinished recording. You can continue where you left off.";
    let actionLabel = props.isReady
      ? "Continue recording"
      : "Enable camera and microphone";
    if (props.pendingAction === "start") {
      actionLabel = "Starting recording…";
    } else if (props.pendingAction === "initialize") {
      actionLabel = "Enabling camera and microphone…";
    }
    content = (
      <>
        <h2
          className="font-semibold text-2xl leading-tight"
          id="journey-state-heading"
        >
          We found an unfinished recording. You can continue where you left off.
        </h2>
        <Button
          className={`${actionClassName} mt-8`}
          disabled={actionsDisabled || (props.isReady && props.captureBlocked)}
          onClick={props.isReady ? props.onStart : props.onInitialize}
          ref={actionRef}
          size="lg"
          type="button"
          variant="outline"
        >
          {actionLabel}
        </Button>
      </>
    );
  } else if (state === "recording") {
    announcement = "Recording started.";
    content = (
      <>
        <h2
          className="flex items-center gap-3 font-semibold text-2xl leading-tight"
          id="journey-state-heading"
        >
          <span aria-hidden="true" className="text-black">
            ●
          </span>
          <span>Recording</span>
        </h2>
        <p className="mt-4 text-gray-600 leading-7">
          Keep this screen open and stay in this browser while you record.
        </p>
        <Button
          className={`${actionClassName} mt-8`}
          disabled={actionsDisabled}
          onClick={props.onStop}
          ref={actionRef}
          size="lg"
          type="button"
          variant="outline"
        >
          {props.pendingAction === "stop"
            ? "Stopping recording…"
            : "Stop recording"}
        </Button>
      </>
    );
  } else if (state === "submitting") {
    announcement = "Submitting your recording.";
    content = (
      <>
        <h2
          className="font-semibold text-2xl leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline"
          id="journey-state-heading"
          ref={submissionHeadingRef}
          tabIndex={-1}
        >
          Submitting your recording.
        </h2>
        <p className="mt-4 font-semibold text-black leading-7">
          {props.finalization?.state === "finalizing"
            ? "Checking and completing your submission"
            : "Waiting to submit"}
        </p>
        <p className="mt-2 text-gray-600 leading-7">
          Your camera and microphone are off. Keep this screen open until
          submission is complete.
        </p>
      </>
    );
  } else if (state === "manual-retry") {
    announcement = "Submission needs attention.";
    content = (
      <>
        <h2
          className="font-semibold text-2xl leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline"
          id="journey-state-heading"
          ref={failureRef}
          tabIndex={-1}
        >
          Submission needs attention
        </h2>
        <div className="mt-6" role="alert">
          <Banner
            className="rounded-lg border border-neutral-200 bg-neutral-50 text-black"
            description={RECORDING_DELIVERY_COPY.finalizationFailure}
            icon={<span aria-hidden="true">!</span>}
            title="Submission needs attention"
            variant="secondary"
          />
        </div>
        <Button
          className={`${actionClassName} mt-6`}
          disabled={actionsDisabled}
          onClick={props.onRetry}
          ref={actionRef}
          size="lg"
          type="button"
          variant="outline"
        >
          {props.pendingAction === "retry"
            ? "Trying to submit…"
            : "Try submitting again"}
        </Button>
      </>
    );
  } else if (state === "missing-recovery") {
    announcement = "This recording can’t be continued.";
    content = (
      <>
        <div role="alert">
          <h2
            className="font-semibold text-2xl leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline"
            id="journey-state-heading"
            ref={failureRef}
            tabIndex={-1}
          >
            This recording can’t be continued
          </h2>
          <div className="mt-6">
            <Banner
              className="rounded-lg border border-neutral-200 bg-neutral-50 text-black"
              description="We couldn’t find your unfinished recording. It can’t be continued."
              icon={<span aria-hidden="true">!</span>}
              title="Recording unavailable"
              variant="secondary"
            />
          </div>
        </div>
        {props.onResetRecoveredRecording ? (
          <Button
            className={`${actionClassName} mt-6`}
            disabled={actionsDisabled}
            onClick={props.onResetRecoveredRecording}
            ref={actionRef}
            size="lg"
            type="button"
            variant="outline"
          >
            Set up a new recording
          </Button>
        ) : null}
      </>
    );
  } else if (state === "terminal-restart") {
    announcement = "This recording couldn’t be saved safely.";
    content = (
      <>
        <div role="alert">
          <h2
            className="font-semibold text-2xl leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline"
            id="journey-state-heading"
            ref={failureRef}
            tabIndex={-1}
          >
            This recording couldn’t be saved safely
          </h2>
          <div className="mt-6">
            <Banner
              className="rounded-lg border border-neutral-200 bg-neutral-50 text-black"
              description={
                props.recordingStopReason === "save-failure"
                  ? RECORDING_DELIVERY_COPY.saveFailure
                  : "Your camera and microphone are off. We couldn’t save this recording safely."
              }
              icon={<span aria-hidden="true">!</span>}
              title="Recording needs attention"
              variant="secondary"
            />
          </div>
        </div>
        {props.onResetRecoveredRecording ? (
          <Button
            className={`${actionClassName} mt-6`}
            disabled={actionsDisabled}
            onClick={props.onResetRecoveredRecording}
            ref={actionRef}
            size="lg"
            type="button"
            variant="outline"
          >
            Start a new recording
          </Button>
        ) : null}
      </>
    );
  } else {
    announcement = "Submission complete.";
    content = (
      <>
        <h2
          className="flex items-center gap-3 font-semibold text-2xl leading-tight"
          id="journey-state-heading"
        >
          <span aria-hidden="true" className="text-black">
            ✓
          </span>
          <span>Submission complete.</span>
        </h2>
        <p className="mt-4 text-gray-600 leading-7">
          Your video was submitted. You may close this tab.
        </p>
      </>
    );
  }

  return (
    <aside
      aria-labelledby="journey-state-heading"
      className="rounded-xl border border-neutral-200 bg-white p-6 text-black sm:p-8"
    >
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {content}
      {delivery.kind === "status" && delivery.message ? (
        <p
          aria-live="polite"
          className="mt-4 text-gray-600 leading-7"
          role="status"
        >
          {delivery.message}
        </p>
      ) : (
        <div
          aria-atomic="true"
          aria-live="polite"
          className="sr-only"
          role="status"
        >
          {asyncSavingMessage}
        </div>
      )}
      {props.blockingError &&
      !delivery.retryPreflight &&
      state !== "manual-retry" &&
      state !== "missing-recovery" &&
      state !== "terminal-restart" ? (
        <div
          className="mt-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-black focus-visible:outline-offset-2 forced-colors:outline"
          role="alert"
          tabIndex={-1}
        >
          <Banner
            className="rounded-lg border border-neutral-200 bg-neutral-50 text-black"
            description={props.blockingError}
            icon={<span aria-hidden="true">!</span>}
            title={props.blockingErrorTitle ?? "Something went wrong"}
            variant="secondary"
          />
        </div>
      ) : null}
    </aside>
  );
}

export function CandidateRecordingJourney(
  props: CandidateRecordingJourneyProps
): React.JSX.Element {
  return (
    <main className="min-h-dvh bg-black text-white">
      <div className="mx-auto grid min-h-dvh max-w-6xl gap-10 px-4 py-8 sm:px-8 sm:py-12 lg:grid-cols-[minmax(0,1.5fr)_minmax(20rem,0.8fr)] lg:items-center lg:gap-14">
        <section aria-labelledby="recording-title">
          <p className="font-medium text-white/60 text-xs uppercase tracking-[0.14em]">
            Video introduction
          </p>
          <h1
            className="mt-4 max-w-2xl font-semibold text-4xl leading-tight tracking-tight sm:text-6xl"
            id="recording-title"
          >
            Tell us about yourself
          </h1>
          <p className="mt-6 max-w-xl text-base text-white/70 leading-7 sm:text-lg">
            Share what you do best, what brought you here, and the kind of work
            you hope to do next.
          </p>
          <CameraStage stream={props.stream} />
        </section>
        <JourneyPanel {...props} />
      </div>
    </main>
  );
}
