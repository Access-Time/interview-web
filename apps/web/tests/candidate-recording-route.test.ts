import { expect, it } from "vitest";
import { candidateJourneyHandoff, usefulError } from "../src/routes/index";

const FORBIDDEN_COPY =
  /\b(session|raw|storage|server|segment|part|queue|acknowledged|finalization|retrieve)\b/i;

it("classifies connection failures as saving guidance", () => {
  const scenarios = [
    {
      error: "fetch failed",
      message:
        "Saving needs attention. Keep this tab open and check your connection.",
      saveState: "healthy" as const,
    },
    {
      error: "network offline",
      message:
        "You’re offline. Keep this tab open; we’ll continue when your connection returns.",
      saveState: "offline" as const,
    },
    {
      error: "upload connection failed",
      message: "Saving is delayed. Keep this tab open while we try again.",
      saveState: "retrying" as const,
    },
  ];

  for (const scenario of scenarios) {
    expect(usefulError(scenario.error, scenario.saveState)).toEqual({
      captureBlocked: false,
      kind: "saving",
      message: scenario.message,
      title: "Saving needs attention",
    });
  }
});

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
    expect(classification.kind).toBe("blocking");
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
    recordingError: "fetch failed",
    saveState: "healthy",
  });

  expect(handoff.savingNotice).toBe(usefulError("fetch failed").message);
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
    recordingError: null,
    saveState: "healthy",
  });
  expect(failed.blockingError).toBe(null);
  expect(failed.blockingErrorTitle).toBe(null);
  expect(failed.hasStopped).toBe(true);
  expect(failed.finalizationState).toBe("failed");
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
      recordingError: error,
      saveState: "healthy",
    });
    expect(handoff.captureBlocked).toBe(captureBlocked);
  }
});
