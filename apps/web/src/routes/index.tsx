import { Button } from "@interview-web/ui/components/button";
import { createFileRoute } from "@tanstack/react-router";
import {
  AlertTriangle,
  Camera,
  Check,
  Circle,
  CloudCheck,
  HardDrive,
  Mic,
  RotateCw,
  Square,
  WifiOff,
} from "lucide-react";
import { useCallback, useEffect, useRef, useState } from "react";
import {
  type UseLiveRecordingResult,
  useLiveRecording,
} from "@/recording/live-recording";
import { client } from "@/utils/orpc";

export const Route = createFileRoute("/")({
  component: HomeComponent,
  head: () => ({ meta: [{ title: "Video introduction" }] }),
});

type PendingAction = "initialize" | "retry" | "start" | "stop";
type FinalizationState = "idle" | "queued" | "finalizing" | "ready" | "failed";

const PERMISSION_ERROR = /permission|notallowed|denied|security/;
const DEVICE_ERROR = /notfound|device|camera|microphone|media/;
const STORAGE_ERROR = /storage|quota|indexeddb|store/;
const NETWORK_ERROR = /network|fetch|upload|offline|connection/;

const SAVE_STATUS = {
  error: {
    Icon: AlertTriangle,
    label: "Saving needs attention",
    tone: "border-red-400/25 bg-red-400/10 text-red-100",
  },
  healthy: {
    Icon: CloudCheck,
    label: "Saving normally",
    tone: "border-emerald-400/25 bg-emerald-400/10 text-emerald-200",
  },
  offline: {
    Icon: WifiOff,
    label: "You’re offline",
    tone: "border-orange-400/25 bg-orange-400/10 text-orange-100",
  },
  retrying: {
    Icon: RotateCw,
    label: "Save delayed — retrying",
    tone: "border-amber-300/25 bg-amber-300/10 text-amber-100",
  },
} as const;

type SaveState = keyof typeof SAVE_STATUS;

const PENDING_GUIDANCE: Record<SaveState, string> = {
  error:
    "Keep this browser tab open. Saving is not retrying automatically. Check your connection; use Try again if it becomes available.",
  healthy: "Keep this browser tab open until saving completes.",
  offline:
    "Keep this browser tab open. Saving resumes when your connection returns.",
  retrying: "Keep this browser tab open while saving tries again.",
};

const NETWORK_GUIDANCE: Record<SaveState, string> = {
  error:
    "Saving stopped and is not retrying automatically. Keep this tab open and check your connection. Use Try again if it becomes available.",
  healthy:
    "Saving is having trouble reaching us. Keep this tab open and check your connection.",
  offline:
    "Saving is paused while you’re offline. Keep this tab open; saving resumes when your connection returns.",
  retrying: "Saving is delayed. Keep this tab open while it tries again.",
};

function usefulError(error: unknown, saveState: SaveState = "healthy") {
  const detail = error instanceof Error ? error.message : String(error);
  const normalized = detail.toLowerCase();

  if (PERMISSION_ERROR.test(normalized)) {
    return "Camera and microphone access was blocked. Allow both in your browser settings, then try again.";
  }
  if (DEVICE_ERROR.test(normalized)) {
    return "We couldn’t connect to both a camera and microphone. Check that they’re plugged in and not in use by another app.";
  }
  if (STORAGE_ERROR.test(normalized)) {
    return "This browser can’t safely hold your recording right now. Free some device storage, then try again.";
  }
  if (NETWORK_ERROR.test(normalized)) {
    return NETWORK_GUIDANCE[saveState];
  }
  return "Something went wrong with the recording. Keep this page open and try the action again.";
}

function useRecordingControls(recording: UseLiveRecordingResult) {
  const [pendingAction, setPendingAction] = useState<PendingAction | null>(
    null
  );
  const [actionError, setActionError] = useState<string | null>(null);
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

function Preview({
  hasStopped,
  isReady,
  isRecording,
  stream,
}: {
  hasStopped: boolean;
  isReady: boolean;
  isRecording: boolean;
  stream: MediaStream | null;
}) {
  const videoRef = useRef<HTMLVideoElement | null>(null);

  useEffect(() => {
    const video = videoRef.current;
    if (video === null) {
      return;
    }

    video.srcObject = stream;
    if (stream !== null) {
      video.play().catch(() => undefined);
    }

    return () => {
      if (video.srcObject === stream) {
        video.srcObject = null;
      }
    };
  }, [stream]);

  return (
    <div className="relative mt-8 overflow-hidden border border-white/10 bg-black shadow-2xl shadow-black/40 sm:mt-10">
      <div className="aspect-video bg-[#151a16]">
        {isReady ? (
          <video
            aria-label="Your camera preview"
            autoPlay
            className="h-full w-full object-cover [transform:scaleX(-1)]"
            muted
            playsInline
            ref={videoRef}
          />
        ) : (
          <div className="flex h-full flex-col items-center justify-center gap-4 text-stone-500">
            <div className="grid size-16 place-items-center rounded-full border border-white/10 bg-white/5">
              <Camera aria-hidden="true" className="size-7" strokeWidth={1.5} />
            </div>
            <p className="text-sm">Your preview will appear here</p>
          </div>
        )}
      </div>

      <PreviewStatus
        hasStopped={hasStopped}
        isReady={isReady}
        isRecording={isRecording}
      />
      {isReady ? <DeviceIndicators /> : null}
    </div>
  );
}

function PreviewStatus({
  hasStopped,
  isReady,
  isRecording,
}: {
  hasStopped: boolean;
  isReady: boolean;
  isRecording: boolean;
}) {
  if (isRecording) {
    return (
      <div
        className="absolute top-3 left-3 flex items-center gap-2 bg-red-500 px-3 py-1.5 font-bold text-white text-xs uppercase tracking-[0.14em] shadow-lg sm:top-4 sm:left-4"
        role="status"
      >
        <Circle aria-hidden="true" className="size-2.5 fill-current" />
        Recording
      </div>
    );
  }
  if (!isReady) {
    return null;
  }
  return (
    <div className="absolute top-3 left-3 flex items-center gap-2 bg-black/70 px-3 py-1.5 font-medium text-stone-200 text-xs backdrop-blur-sm sm:top-4 sm:left-4">
      <Check aria-hidden="true" className="size-3.5 text-lime-300" />
      {hasStopped ? "Capture stopped" : "Camera and microphone ready"}
    </div>
  );
}

function DeviceIndicators() {
  return (
    <div className="absolute right-3 bottom-3 flex gap-2 sm:right-4 sm:bottom-4">
      <span
        className="grid size-9 place-items-center rounded-full bg-black/70 text-stone-200 backdrop-blur-sm"
        title="Camera on"
      >
        <Camera aria-hidden="true" className="size-4" />
        <span className="sr-only">Camera on</span>
      </span>
      <span
        className="grid size-9 place-items-center rounded-full bg-black/70 text-stone-200 backdrop-blur-sm"
        title="Microphone on"
      >
        <Mic aria-hidden="true" className="size-4" />
        <span className="sr-only">Microphone on</span>
      </span>
    </div>
  );
}

function getControlCopy({
  finalizationState,
  hasStopped,
  isReady,
  isRecording,
}: {
  finalizationState: FinalizationState;
  hasStopped: boolean;
  isReady: boolean;
  isRecording: boolean;
}) {
  if (hasStopped) {
    if (finalizationState === "ready") {
      return { heading: "Your video has been submitted.", label: "Complete" };
    }
    if (finalizationState === "failed") {
      return {
        heading: "Your recording is saved.",
        label: "Finalization needs attention",
      };
    }
    return {
      heading: "We’re preparing your submission.",
      label: "Capture complete",
    };
  }
  if (isRecording) {
    return {
      heading: "Take your time and be yourself.",
      label: "Now recording",
    };
  }
  if (isReady) {
    return { heading: "Everything looks ready.", label: "Ready to begin" };
  }
  return { heading: "Check your camera and sound.", label: "Before you begin" };
}

function RecordingAction({
  finalizationState,
  hasStopped,
  isReady,
  isRecording,
  onInitialize,
  onRetryFinalization,
  onStart,
  onStop,
  pendingAction,
}: {
  finalizationState: FinalizationState;
  hasStopped: boolean;
  isReady: boolean;
  isRecording: boolean;
  onInitialize: () => void;
  onRetryFinalization: () => void;
  onStart: () => void;
  onStop: () => void;
  pendingAction: PendingAction | null;
}) {
  if (!isReady) {
    return (
      <Button
        className="h-12 w-full bg-lime-300 px-5 font-bold text-[#11150e] text-sm hover:bg-lime-200 focus-visible:ring-lime-300/60"
        disabled={pendingAction !== null}
        onClick={onInitialize}
        type="button"
      >
        <Camera aria-hidden="true" />
        {pendingAction === "initialize"
          ? "Enabling…"
          : "Enable camera and microphone"}
      </Button>
    );
  }
  if (isRecording) {
    return (
      <Button
        className="h-12 w-full border-red-300/30 bg-red-400/10 px-5 font-bold text-red-100 text-sm hover:bg-red-400/20 focus-visible:ring-red-300/50"
        disabled={pendingAction !== null}
        onClick={onStop}
        type="button"
        variant="outline"
      >
        <Square aria-hidden="true" className="fill-current" />
        {pendingAction === "stop" ? "Stopping…" : "Stop capture"}
      </Button>
    );
  }
  if (hasStopped) {
    if (finalizationState === "ready") {
      return (
        <div
          className="flex gap-3 border border-emerald-400/25 bg-emerald-400/10 p-4 text-emerald-100"
          role="status"
        >
          <CloudCheck
            aria-hidden="true"
            className="mt-0.5 size-5 shrink-0 text-emerald-300"
          />
          <p className="text-sm leading-6">
            Your submission has been validated and is ready to retrieve.
          </p>
        </div>
      );
    }
    if (finalizationState === "failed") {
      return (
        <div aria-live="polite">
          <div className="flex gap-3 border border-amber-300/25 bg-amber-300/10 p-4 text-amber-100">
            <AlertTriangle
              aria-hidden="true"
              className="mt-0.5 size-5 shrink-0 text-amber-300"
            />
            <p className="text-sm leading-6">
              Your recorded source is still saved. We couldn’t finish the
              submission. Keep this tab open and try finalization again.
            </p>
          </div>
          <Button
            className="mt-3 h-12 w-full bg-lime-300 px-5 font-bold text-[#11150e] text-sm hover:bg-lime-200 focus-visible:ring-lime-300/60"
            disabled={pendingAction !== null}
            onClick={onRetryFinalization}
            type="button"
          >
            <RotateCw
              aria-hidden="true"
              className={pendingAction === "retry" ? "animate-spin" : ""}
            />
            {pendingAction === "retry" ? "Retrying…" : "Retry finalization"}
          </Button>
        </div>
      );
    }
    return (
      <div aria-live="polite" className="flex gap-3" role="status">
        <RotateCw
          aria-hidden="true"
          className="mt-1 size-4 shrink-0 animate-spin text-lime-300"
        />
        <div>
          <p className="text-sm text-stone-200 leading-6">
            {finalizationState === "finalizing"
              ? "We’re validating and finishing your submission."
              : "Your submission is queued and will begin shortly."}
          </p>
          <p className="mt-1 text-sm text-stone-400 leading-6">
            Keep this tab open until your submission is complete.
          </p>
        </div>
      </div>
    );
  }
  return (
    <Button
      className="h-12 w-full bg-lime-300 px-5 font-bold text-[#11150e] text-sm hover:bg-lime-200 focus-visible:ring-lime-300/60"
      disabled={pendingAction !== null}
      onClick={onStart}
      type="button"
    >
      <Circle aria-hidden="true" className="fill-current" />
      {pendingAction === "start" ? "Starting…" : "Start recording"}
    </Button>
  );
}

function RecordingControls({
  actionError,
  hasStopped,
  onInitialize,
  onRetryFinalization,
  onStart,
  onStop,
  pendingAction,
  recording,
}: {
  actionError: string | null;
  hasStopped: boolean;
  onInitialize: () => void;
  onRetryFinalization: () => void;
  onStart: () => void;
  onStop: () => void;
  pendingAction: PendingAction | null;
  recording: UseLiveRecordingResult;
}) {
  const finalizationState = recording.finalization?.state ?? "idle";
  const copy = getControlCopy({
    finalizationState,
    hasStopped,
    isReady: recording.isReady,
    isRecording: recording.isRecording,
  });
  const displayedError =
    finalizationState === "failed"
      ? null
      : (actionError ??
        (recording.error
          ? usefulError(recording.error, recording.saveState)
          : null));

  return (
    <div className="border border-white/10 bg-[#151916]/95 p-5 shadow-black/20 shadow-xl sm:p-7">
      <p className="font-semibold text-stone-500 text-xs uppercase tracking-[0.16em]">
        {copy.label}
      </p>
      <h2 className="mt-3 font-serif text-2xl text-stone-50 leading-tight">
        {copy.heading}
      </h2>

      {recording.isReady ? null : (
        <p className="mt-3 text-sm text-stone-400 leading-6">
          We’ll ask for access to your camera and microphone, then show you a
          private preview before anything is recorded.
        </p>
      )}

      {displayedError ? (
        <div
          className="mt-5 flex gap-3 border border-red-400/25 bg-red-400/10 p-3 text-red-100 text-sm leading-5"
          role="alert"
        >
          <AlertTriangle
            aria-hidden="true"
            className="mt-0.5 size-4 shrink-0 text-red-300"
          />
          <p>{displayedError}</p>
        </div>
      ) : null}

      <div className="mt-6">
        <RecordingAction
          finalizationState={finalizationState}
          hasStopped={hasStopped}
          isReady={recording.isReady}
          isRecording={recording.isRecording}
          onInitialize={onInitialize}
          onRetryFinalization={onRetryFinalization}
          onStart={onStart}
          onStop={onStop}
          pendingAction={pendingAction}
        />
      </div>
    </div>
  );
}

function SaveStatus({ recording }: { recording: UseLiveRecordingResult }) {
  const saveStatus = SAVE_STATUS[recording.saveState];
  const pendingLabel = `${recording.pendingPartCount} ${recording.pendingPartCount === 1 ? "part" : "parts"} waiting`;
  const localSaveCopy =
    recording.pendingPartCount > 0
      ? `${pendingLabel}. Capture data is saved locally before it is sent.`
      : "Capture data is saved locally before it is sent. Nothing is currently waiting.";

  return (
    <section
      aria-labelledby="save-status-title"
      className="mt-4 border border-white/10 bg-white/[0.035] p-5 sm:p-6"
    >
      <div className="flex items-start justify-between gap-4">
        <div>
          <p
            className="font-semibold text-stone-500 text-xs uppercase tracking-[0.15em]"
            id="save-status-title"
          >
            Save status
          </p>
          <div aria-live="polite" className="mt-3" role="status">
            <span
              className={`inline-flex items-center gap-2 border px-2.5 py-1.5 font-semibold text-xs ${saveStatus.tone}`}
            >
              <saveStatus.Icon
                aria-hidden="true"
                className={`size-3.5 ${recording.saveState === "retrying" ? "animate-spin" : ""}`}
              />
              {saveStatus.label}
            </span>
          </div>
        </div>
        <div className="text-right">
          <p className="font-serif text-2xl text-stone-100 tabular-nums">
            {recording.pendingPartCount}
          </p>
          <p className="text-stone-500 text-xs">waiting</p>
        </div>
      </div>

      <div className="mt-4 flex gap-3 border-white/10 border-t pt-4">
        <HardDrive
          aria-hidden="true"
          className="mt-0.5 size-4 shrink-0 text-stone-500"
        />
        <p className="text-sm text-stone-400 leading-5">{localSaveCopy}</p>
      </div>

      {recording.pendingPartCount > 0 ? (
        <p className="mt-4 bg-white/5 px-3 py-2.5 text-stone-300 text-xs leading-5">
          {PENDING_GUIDANCE[recording.saveState]}
        </p>
      ) : null}
    </section>
  );
}

function HomeComponent() {
  const recording = useLiveRecording({
    appendSegment: (input) => client.recording.appendSegment(input),
    createSession: (input) => client.recording.create(input),
    finalizeSession: (input) => client.recording.finalize(input),
    getFinalizationStatus: (input) => client.recording.getStatus(input),
  });
  const controls = useRecordingControls(recording);
  const finalizationState = recording.finalization?.state ?? "idle";
  const hasStopped = controls.hasStopped || finalizationState !== "idle";

  return (
    <main className="relative min-h-0 overflow-y-auto bg-[#0b0e0c] text-stone-100 selection:bg-lime-300 selection:text-[#10130d]">
      <div
        aria-hidden="true"
        className="pointer-events-none absolute inset-0 opacity-40 [background-image:radial-gradient(circle_at_12%_12%,rgba(190,242,100,0.15),transparent_28%),radial-gradient(circle_at_88%_70%,rgba(120,113,108,0.18),transparent_32%)]"
      />

      <div className="relative mx-auto grid min-h-full max-w-7xl gap-10 px-4 py-8 sm:px-8 sm:py-12 lg:grid-cols-[minmax(0,1.55fr)_minmax(19rem,0.75fr)] lg:items-center lg:gap-14 xl:px-12">
        <section aria-labelledby="recording-title" className="min-w-0">
          <div className="mb-7 flex items-center gap-3 font-semibold text-lime-300 text-xs uppercase tracking-[0.18em]">
            <span className="h-px w-8 bg-lime-300" />
            Video introduction
          </div>

          <div className="max-w-3xl">
            <h1
              className="text-balance font-serif text-4xl text-stone-50 leading-[0.98] tracking-[-0.035em] sm:text-6xl lg:text-7xl"
              id="recording-title"
            >
              Tell us about yourself
            </h1>
            <p className="mt-5 max-w-2xl text-pretty text-base text-stone-400 leading-7 sm:text-lg">
              Share what you do best, what brought you here, and the kind of
              work you hope to do next. Speak naturally—we’re interested in you,
              not a perfect take.
            </p>
          </div>

          <Preview
            hasStopped={hasStopped}
            isReady={recording.isReady}
            isRecording={recording.isRecording}
            stream={recording.stream}
          />
        </section>

        <aside aria-label="Recording controls" className="lg:pt-16">
          <RecordingControls
            actionError={controls.actionError}
            hasStopped={hasStopped}
            onInitialize={controls.handleInitialize}
            onRetryFinalization={controls.handleRetryFinalization}
            onStart={controls.handleStart}
            onStop={controls.handleStop}
            pendingAction={controls.pendingAction}
            recording={recording}
          />
          <SaveStatus recording={recording} />
        </aside>
      </div>
    </main>
  );
}
