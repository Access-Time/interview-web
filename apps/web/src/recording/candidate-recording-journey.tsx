import { Banner } from "@cloudflare/kumo/components/banner";
import { Button } from "@cloudflare/kumo/components/button";
import { useEffect, useRef } from "react";
import type {
  RecordingFinalizationResult,
  RecordingSaveState,
} from "./live-recording";

// biome-ignore lint: preserve the approved public type-alias contract.
export type CandidateRecordingJourneyProps = {
  blockingError: string | null;
  finalization: RecordingFinalizationResult | null;
  hasStopped: boolean;
  isReady: boolean;
  isRecording: boolean;
  onInitialize: () => void;
  onRetry: () => void;
  onStart: () => void;
  onStop: () => void;
  pendingAction: "initialize" | "retry" | "start" | "stop" | null;
  recovered: boolean;
  saveState: RecordingSaveState;
  stream: MediaStream | null;
};

type JourneyState =
  | "permission"
  | "ready"
  | "recovered"
  | "recording"
  | "submitting"
  | "failed"
  | "success";

function journeyState(props: CandidateRecordingJourneyProps): JourneyState {
  if (props.finalization?.state === "ready") {
    return "success";
  }
  if (props.finalization?.state === "failed") {
    return "failed";
  }
  if (props.isRecording) {
    return "recording";
  }
  if (
    props.hasStopped ||
    props.finalization?.state === "queued" ||
    props.finalization?.state === "finalizing"
  ) {
    return "submitting";
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
    <div className="mt-8 aspect-video overflow-hidden border border-white/40 bg-black shadow-[10px_10px_0_0_#2563eb] sm:mt-10">
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

const saveMessages: Record<Exclude<RecordingSaveState, "healthy">, string> = {
  error:
    "Saving needs attention. Keep this tab open and check your connection.",
  offline:
    "You’re offline. Keep this tab open; we’ll continue when your connection returns.",
  retrying: "Saving is delayed. Keep this tab open while we try again.",
};

function SaveNotice({ saveState }: { saveState: RecordingSaveState }) {
  if (saveState === "healthy") {
    return null;
  }
  return (
    <Banner
      className="mt-6 rounded-none border border-black/20 bg-white text-black"
      description={saveMessages[saveState]}
      size="sm"
      variant="secondary"
    />
  );
}

// biome-ignore lint/complexity/noExcessiveCognitiveComplexity: explicit finite journey states stay together for review.
function JourneyPanel(props: CandidateRecordingJourneyProps) {
  const state = journeyState(props);
  const actionRef = useRef<HTMLButtonElement | null>(null);
  const submissionHeadingRef = useRef<HTMLHeadingElement | null>(null);
  const failureRef = useRef<HTMLHeadingElement | null>(null);
  const previous = useRef({ isReady: props.isReady, state });

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
    } else if (last.state === "submitting" && state === "failed") {
      failureRef.current?.focus();
    }
    previous.current = { isReady: props.isReady, state };
  }, [props.isReady, state]);

  const actionsDisabled = props.pendingAction !== null;
  const actionClassName =
    "min-h-12 w-full rounded-none !bg-blue-600 px-5 font-semibold !text-white hover:!bg-blue-700 focus-visible:ring-0 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-blue-600 forced-colors:outline";
  let announcement = "";
  let content: React.JSX.Element;

  if (state === "permission") {
    announcement = "Set up your camera and microphone.";
    content = (
      <>
        <h2 className="font-semibold font-serif text-3xl leading-tight">
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
        <h2 className="font-semibold font-serif text-3xl leading-tight">
          You’re ready to record.
        </h2>
        <p className="mt-4 text-gray-600 leading-7">
          Recording begins only after you choose Start recording.
        </p>
        <Button
          className={`${actionClassName} mt-8`}
          disabled={actionsDisabled}
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
        <h2 className="font-semibold font-serif text-3xl leading-tight">
          We found an unfinished recording. You can continue where you left off.
        </h2>
        <Button
          className={`${actionClassName} mt-8`}
          disabled={actionsDisabled}
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
        <h2 className="flex items-center gap-3 font-semibold font-serif text-3xl leading-tight">
          <span aria-hidden="true" className="text-blue-600">
            ●
          </span>
          <span>Recording</span>
        </h2>
        <p className="mt-4 text-gray-600 leading-7">
          Take your time and speak naturally.
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
          className="font-semibold font-serif text-3xl leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 focus-visible:outline-offset-4 forced-colors:outline"
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
        <p className="mt-2 text-gray-600 leading-7">Keep this tab open.</p>
      </>
    );
  } else if (state === "failed") {
    announcement =
      "Your recording is saved, but we couldn’t finish submitting it.";
    content = (
      <>
        <h2
          className="font-semibold font-serif text-3xl leading-tight focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 focus-visible:outline-offset-4 forced-colors:outline"
          ref={failureRef}
          tabIndex={-1}
        >
          Your recording is saved, but we couldn’t finish submitting it.
        </h2>
        <div className="mt-6">
          <Banner
            className="rounded-none border border-black/20"
            description="Keep this tab open, then try again."
            icon={<span aria-hidden="true">!</span>}
            title="Submission needs attention"
            variant="error"
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
  } else {
    announcement = "Submission complete.";
    content = (
      <>
        <h2 className="flex items-center gap-3 font-semibold font-serif text-3xl leading-tight">
          <span aria-hidden="true" className="text-blue-600">
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
      aria-label="Recording controls"
      className="border border-white bg-white p-6 text-black shadow-[10px_10px_0_0_#2563eb] sm:p-8 lg:p-10"
    >
      <div aria-atomic="true" aria-live="polite" className="sr-only">
        {announcement}
      </div>
      {content}
      {props.blockingError && state !== "failed" ? (
        <div
          className="mt-6 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-600 focus-visible:outline-offset-4 forced-colors:outline"
          role="alert"
          tabIndex={-1}
        >
          <Banner
            className="rounded-none border border-black/20"
            description={props.blockingError}
            icon={<span aria-hidden="true">!</span>}
            title="Check your camera and microphone"
            variant="error"
          />
        </div>
      ) : null}
      <SaveNotice saveState={props.saveState} />
    </aside>
  );
}

export function CandidateRecordingJourney(
  props: CandidateRecordingJourneyProps
): React.JSX.Element {
  return (
    <main className="min-h-dvh bg-black text-white">
      <div className="mx-auto grid min-h-dvh max-w-7xl gap-12 px-4 py-8 sm:px-8 sm:py-12 lg:grid-cols-[minmax(0,1.55fr)_minmax(20rem,0.75fr)] lg:items-center lg:gap-16">
        <section aria-labelledby="recording-title">
          <p className="font-semibold text-blue-300 text-xs uppercase tracking-[0.16em]">
            Video introduction
          </p>
          <h1
            className="mt-4 max-w-2xl font-semibold font-serif text-5xl leading-[0.95] tracking-tight sm:text-7xl"
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
