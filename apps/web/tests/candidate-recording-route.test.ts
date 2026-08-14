import { expect, it, vi } from "vitest";
import { RECORDING_DELIVERY_COPY } from "../src/recording/candidate-recording-journey";
import {
  candidateJourneyHandoff,
  recordingManifestLookup,
  shouldWarnBeforeUnload,
  usefulError,
} from "../src/routes/index";

const FORBIDDEN_COPY =
  /\b(session|raw|storage|server|segment|part|queue|acknowledged|finalization|retrieve)\b/i;

it("keeps non-network failures blocking and candidate-safe", () => {
  const scenarios = [
    ["permission denied", "Camera and microphone access blocked"],
    ["device notfound", "Camera or microphone unavailable"],
    ["quota exceeded", "Recording can’t be saved"],
    ["conflicting parts", "Recording needs attention"],
    ["unexpected failure", "Recording needs attention"],
  ] as const;

  for (const [error, title] of scenarios) {
    const classification = usefulError(error);
    expect(classification.title).toBe(title);
    expect(FORBIDDEN_COPY.test(classification.message)).toBe(false);
    expect(FORBIDDEN_COPY.test(classification.title)).toBe(false);
    expect(classification.captureBlocked).toBe(
      error === "quota exceeded" || error === "conflicting parts"
    );
  }
});

it("hands saving failures to the notice only", () => {
  const handoff = candidateJourneyHandoff({
    actionError: null,
    captureEnded: false,
    controlsHasStopped: false,
    finalizationState: "idle",
    journeyOutcome: "automatic-retry",
    recordingError: "fetch failed",
    saveState: "healthy",
  });

  expect(handoff.savingNotice).toBe(
    "Keep this screen open; we’ll keep trying."
  );
  expect(handoff.blockingError).toBe(null);
  expect(handoff.blockingErrorTitle).toBe(null);
  expect(handoff.finalizationState).toBe("idle");
  expect(handoff.hasStopped).toBe(false);
});

it("hands off blocking failures and suppresses them after failed submission", () => {
  const classification = usefulError("permission denied");
  const visible = candidateJourneyHandoff({
    actionError: classification,
    captureEnded: false,
    controlsHasStopped: false,
    finalizationState: "idle",
    journeyOutcome: "none",
    recordingError: null,
    saveState: "healthy",
  });
  expect(visible.blockingError).toBe(classification.message);
  expect(visible.blockingErrorTitle).toBe(classification.title);
  expect(visible.savingNotice).toBe(null);

  const failed = candidateJourneyHandoff({
    actionError: classification,
    captureEnded: false,
    controlsHasStopped: false,
    finalizationState: "failed",
    journeyOutcome: "manual-retry",
    recordingError: null,
    saveState: "healthy",
  });
  expect(failed.blockingError).toBe(null);
  expect(failed.blockingErrorTitle).toBe(null);
  expect(failed.hasStopped).toBe(true);
  expect(failed.finalizationState).toBe("failed");
  expect(failed.journeyOutcome).toBe("manual-retry");
});

it("preserves stopped semantics for pending and terminal states", () => {
  for (const finalizationState of [
    "queued",
    "finalizing",
    "ready",
    "failed",
  ] as const) {
    const handoff = candidateJourneyHandoff({
      actionError: null,
      captureEnded: false,
      controlsHasStopped: false,
      finalizationState,
      journeyOutcome: "none",
      recordingError: null,
      saveState: "healthy",
    });
    expect(handoff.finalizationState).toBe(finalizationState);
    expect(handoff.hasStopped).toBe(true);
  }

  const locallyStopped = candidateJourneyHandoff({
    actionError: null,
    captureEnded: false,
    controlsHasStopped: true,
    finalizationState: "idle",
    journeyOutcome: "none",
    recordingError: null,
    saveState: "healthy",
  });
  expect(locallyStopped.hasStopped).toBe(true);
});

it("capture-ended signal produces stopped handoff immediately", () => {
  const handoff = candidateJourneyHandoff({
    actionError: null,
    captureEnded: true,
    controlsHasStopped: false,
    finalizationState: "idle",
    journeyOutcome: "none",
    recordingError: null,
    saveState: "healthy",
  });
  expect(handoff.hasStopped).toBe(true);
  expect(handoff.finalizationState).toBe("idle");
});

it("blocks capture handoff only for unsafe recording failures", () => {
  for (const [error, captureBlocked] of [
    ["quota exceeded", true],
    ["missing ordered parts", true],
    ["permission denied", false],
    ["device notfound", false],
    ["fetch failed", false],
  ] as const) {
    const handoff = candidateJourneyHandoff({
      actionError: null,
      captureEnded: false,
      controlsHasStopped: false,
      finalizationState: "idle",
      journeyOutcome: "none",
      recordingError: error,
      saveState: "healthy",
    });
    expect(handoff.captureBlocked).toBe(captureBlocked);
  }
});

it("does not describe a fatal 400 upload as retryable network saving", () => {
  const handoff = candidateJourneyHandoff({
    actionError: null,
    captureEnded: true,
    controlsHasStopped: false,
    finalizationState: "idle",
    journeyOutcome: "terminal-restart",
    recordingError: "Recording part upload failed (400)",
    saveState: "error",
  });

  expect(handoff.hasStopped).toBe(true);
  expect(handoff.journeyOutcome).toBe("terminal-restart");
  expect(handoff.savingNotice).toBeNull();
});

it("maps only typed RECORDING_NOT_FOUND manifest failures to missing", async () => {
  const notFound = Object.assign(new Error("missing"), {
    code: "RECORDING_NOT_FOUND",
  });
  await expect(
    recordingManifestLookup(() => Promise.reject(notFound), {
      sessionId: "recording-1",
    })
  ).resolves.toEqual({ kind: "missing" });
});

it("prefers capacity and save-failure delivery copy", () => {
  expect(
    candidateJourneyHandoff({
      captureEnded: true,
      hasUnsentRecordingMedia: true,
      recordingStopReason: "capacity",
    }).deliveryMessage
  ).toBe(RECORDING_DELIVERY_COPY.capacity);

  expect(
    candidateJourneyHandoff({
      captureEnded: true,
      recordingStopReason: "save-failure",
    }).blockingError
  ).toBe(RECORDING_DELIVERY_COPY.saveFailure);
});

it("warns before unload during capture, unsent media, or incomplete finalization", () => {
  const warn = (input: Parameters<typeof shouldWarnBeforeUnload>[0]) => {
    const event = new Event("beforeunload") as BeforeUnloadEvent;
    const preventDefault = vi.fn();
    event.preventDefault = preventDefault;
    if (shouldWarnBeforeUnload(input)) {
      event.preventDefault();
      event.returnValue = "";
    }
    return preventDefault;
  };

  expect(
    warn({
      hasIncompleteRecordingFinalization: false,
      hasUnsentRecordingMedia: false,
      recording: true,
    })
  ).toHaveBeenCalled();
  expect(
    warn({
      hasIncompleteRecordingFinalization: false,
      hasUnsentRecordingMedia: true,
      recording: false,
    })
  ).toHaveBeenCalled();
  expect(
    warn({
      hasIncompleteRecordingFinalization: true,
      hasUnsentRecordingMedia: false,
      recording: false,
    })
  ).toHaveBeenCalled();
  expect(
    warn({
      hasIncompleteRecordingFinalization: false,
      hasUnsentRecordingMedia: false,
      recording: false,
    })
  ).not.toHaveBeenCalled();
});

it("rethrows manifest transport failures unchanged", async () => {
  const failure = new Error("deployment unavailable");
  await expect(
    recordingManifestLookup(() => Promise.reject(failure), {
      sessionId: "recording-1",
    })
  ).rejects.toBe(failure);
});
