import assert from "node:assert/strict";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { runnerImport } from "vite";

interface CandidateError {
  captureBlocked: boolean;
  kind: "blocking" | "saving";
  message: string;
  title: string;
}

interface RouteModule {
  candidateJourneyHandoff: (input: {
    actionError: CandidateError | null;
    captureEnded: boolean;
    controlsHasStopped: boolean;
    finalizationState: "failed" | "finalizing" | "idle" | "queued" | "ready";
    recordingError: string | null;
    saveState: "error" | "healthy" | "offline" | "retrying";
  }) => {
    blockingError: string | null;
    blockingErrorTitle: string | null;
    captureBlocked: boolean;
    finalizationState: string;
    hasStopped: boolean;
    savingNotice: string | null;
  };
  usefulError: (
    error: unknown,
    saveState?: "error" | "healthy" | "offline" | "retrying"
  ) => CandidateError;
}

const routePath = fileURLToPath(
  new URL("../src/routes/index.tsx", import.meta.url)
);
const { module: route } = await runnerImport<RouteModule>(routePath, {
  configFile: false,
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("../src", import.meta.url)),
      "cloudflare:workers": fileURLToPath(
        new URL(
          "../../../packages/env/src/cloudflare-local.ts",
          import.meta.url
        )
      ),
    },
  },
});

const FORBIDDEN_COPY =
  /\b(session|raw|storage|server|segment|part|queue|acknowledged|finalization|retrieve)\b/i;

test("classifies connection failures as saving guidance", () => {
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
    assert.deepEqual(route.usefulError(scenario.error, scenario.saveState), {
      captureBlocked: false,
      kind: "saving",
      message: scenario.message,
      title: "Saving needs attention",
    });
  }
});

test("keeps non-network failures blocking and candidate-safe", () => {
  const scenarios = [
    ["permission denied", "Camera and microphone access blocked"],
    ["device notfound", "Camera or microphone unavailable"],
    ["quota exceeded", "Recording can’t be saved"],
    ["conflicting parts", "Recording needs attention"],
    ["unexpected failure", "Recording needs attention"],
  ] as const;

  for (const [error, title] of scenarios) {
    const classification = route.usefulError(error);
    assert.equal(classification.kind, "blocking");
    assert.equal(classification.title, title);
    assert.equal(FORBIDDEN_COPY.test(classification.message), false);
    assert.equal(FORBIDDEN_COPY.test(classification.title), false);
    assert.equal(
      classification.captureBlocked,
      error === "quota exceeded" || error === "conflicting parts"
    );
  }
});

test("hands saving failures to the notice only", () => {
  const handoff = route.candidateJourneyHandoff({
    actionError: null,
    captureEnded: false,
    controlsHasStopped: false,
    finalizationState: "idle",
    recordingError: "fetch failed",
    saveState: "healthy",
  });

  assert.equal(handoff.savingNotice, route.usefulError("fetch failed").message);
  assert.equal(handoff.blockingError, null);
  assert.equal(handoff.blockingErrorTitle, null);
  assert.equal(handoff.finalizationState, "idle");
  assert.equal(handoff.hasStopped, false);
});

test("hands off blocking failures and suppresses them after failed submission", () => {
  const classification = route.usefulError("permission denied");
  const visible = route.candidateJourneyHandoff({
    actionError: classification,
    captureEnded: false,
    controlsHasStopped: false,
    finalizationState: "idle",
    recordingError: null,
    saveState: "healthy",
  });
  assert.equal(visible.blockingError, classification.message);
  assert.equal(visible.blockingErrorTitle, classification.title);
  assert.equal(visible.savingNotice, null);

  const failed = route.candidateJourneyHandoff({
    actionError: classification,
    captureEnded: false,
    controlsHasStopped: false,
    finalizationState: "failed",
    recordingError: null,
    saveState: "healthy",
  });
  assert.equal(failed.blockingError, null);
  assert.equal(failed.blockingErrorTitle, null);
  assert.equal(failed.hasStopped, true);
  assert.equal(failed.finalizationState, "failed");
});

test("preserves stopped semantics for pending and terminal states", () => {
  for (const finalizationState of [
    "queued",
    "finalizing",
    "ready",
    "failed",
  ] as const) {
    const handoff = route.candidateJourneyHandoff({
      actionError: null,
      captureEnded: false,
      controlsHasStopped: false,
      finalizationState,
      recordingError: null,
      saveState: "healthy",
    });
    assert.equal(handoff.finalizationState, finalizationState);
    assert.equal(handoff.hasStopped, true);
  }

  const locallyStopped = route.candidateJourneyHandoff({
    actionError: null,
    captureEnded: false,
    controlsHasStopped: true,
    finalizationState: "idle",
    recordingError: null,
    saveState: "healthy",
  });
  assert.equal(locallyStopped.hasStopped, true);
});

test("capture-ended signal produces stopped handoff immediately", () => {
  const handoff = route.candidateJourneyHandoff({
    actionError: null,
    captureEnded: true,
    controlsHasStopped: false,
    finalizationState: "idle",
    recordingError: null,
    saveState: "healthy",
  });
  assert.equal(handoff.hasStopped, true);
  assert.equal(handoff.finalizationState, "idle");
});

test("blocks capture handoff only for unsafe recording failures", () => {
  for (const [error, captureBlocked] of [
    ["quota exceeded", true],
    ["missing ordered parts", true],
    ["permission denied", false],
    ["device notfound", false],
    ["fetch failed", false],
  ] as const) {
    const handoff = route.candidateJourneyHandoff({
      actionError: null,
      captureEnded: false,
      controlsHasStopped: false,
      finalizationState: "idle",
      recordingError: error,
      saveState: "healthy",
    });
    assert.equal(handoff.captureBlocked, captureBlocked);
  }
});
