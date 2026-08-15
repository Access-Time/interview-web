import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import React from "react";
import { afterEach, expect, it } from "vitest";
import type { CandidateRecordingJourneyProps } from "../src/recording/candidate-recording-journey";
import {
  CandidateRecordingJourney,
  RECORDING_DELIVERY_COPY,
} from "../src/recording/candidate-recording-journey";

const CLOSE_TAB_PATTERN = /may close this tab/i;
const CAMERA_OFF_PATTERN = /Your camera and microphone are off/i;
const NEW_RECORDING_PATTERN = /start a new recording/i;
const RECORDING_GUIDANCE_PATTERN =
  /Keep this screen open and stay in this browser while you record/i;
const IMPLEMENTATION_LANGUAGE_PATTERN =
  /\b(session|raw|storage|server|segment|part|queue|acknowledged|finalization|retrieve)\b/i;
const START_BUTTON_PATTERN = /start/i;
const TRY_AGAIN_PATTERN = /try again/i;
const RETRY_SUBMIT_PATTERN = /try submitting again/i;
const IMPLEMENTATION_TERM_PATTERN = /\b(part|queue|IndexedDB|quota)\b/i;

const baseProps: CandidateRecordingJourneyProps = {
  blockingError: null,
  blockingErrorTitle: null,
  captureBlocked: false,
  finalization: null,
  hasIncompleteRecordingFinalization: false,
  hasStopped: false,
  hasUnsentRecordingMedia: false,
  isReady: false,
  isRecording: false,
  journeyOutcome: "none",
  onInitialize: () => undefined,
  onRetry: () => undefined,
  onRetryPreflight: () => undefined,
  onStart: () => undefined,
  onStop: () => undefined,
  pendingAction: null,
  recordingDeliveryPhase: "idle",
  recordingPreflightState: "idle",
  recordingStopReason: null,
  recovered: false,
  saveState: "healthy",
  savingNotice: null,
  stream: null,
};

afterEach(() => {
  cleanup();
});

it("shows one candidate action for each active primary state", () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, baseProps)
  );
  expect(
    screen.getByRole("heading", {
      name: "Set up your camera and microphone.",
    })
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Enable camera and microphone" })
  ).toBeTruthy();
  expect(screen.getAllByRole("button").length).toBe(1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
    })
  );
  expect(
    screen.getByRole("heading", { name: "You’re ready to record." })
  ).toBeTruthy();
  expect(screen.getByRole("button", { name: "Start recording" })).toBeTruthy();
  expect(screen.getAllByRole("button").length).toBe(1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      isRecording: true,
    })
  );
  expect(screen.getByText("Recording")).toBeTruthy();
  expect(screen.getByRole("button", { name: "Stop recording" })).toBeTruthy();
  expect(screen.getAllByRole("button").length).toBe(1);
});

it("shows foreground guidance without offering an ordinary restart", () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      isRecording: true,
    })
  );
  expect(screen.getByText(RECORDING_GUIDANCE_PATTERN)).toBeTruthy();
  expect(screen.getAllByRole("status")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: NEW_RECORDING_PATTERN })
  ).toBeNull();

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: null, state: "queued" },
      hasStopped: true,
    })
  );
  expect(screen.getByText(CAMERA_OFF_PATTERN)).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: NEW_RECORDING_PATTERN })
  ).toBeNull();

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: null, state: "ready" },
      hasStopped: true,
    })
  );
  expect(
    screen.queryByRole("button", { name: NEW_RECORDING_PATTERN })
  ).toBeNull();
});

it("continues a recovered recording and retries a failed submission", () => {
  let starts = 0;
  let retries = 0;
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      onRetry: () => {
        retries += 1;
      },
      onStart: () => {
        starts += 1;
      },
      recovered: true,
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Continue recording" }));
  expect(starts).toBe(1);
  expect(screen.getAllByRole("button").length).toBe(1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: "failed", state: "failed" },
      hasStopped: true,
      journeyOutcome: "manual-retry",
      onRetry: () => {
        retries += 1;
      },
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Try submitting again" }));
  expect(retries).toBe(1);
  expect(
    screen.getByText(RECORDING_DELIVERY_COPY.finalizationFailure)
  ).toBeTruthy();
  expect(screen.getAllByRole("button").length).toBe(1);
});

it("offers reset only for typed restart outcomes", () => {
  let resets = 0;
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      hasStopped: true,
      journeyOutcome: "terminal-restart",
    })
  );
  expect(screen.getByText(CAMERA_OFF_PATTERN)).toBeTruthy();
  expect(screen.getByRole("alert")).toBeTruthy();
  expect(
    screen.queryByRole("button", { name: "Start a new recording" })
  ).toBeNull();

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      hasStopped: true,
      journeyOutcome: "terminal-restart",
      onResetRecoveredRecording: () => {
        resets += 1;
      },
    })
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Start a new recording" })
  );
  expect(resets).toBe(1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      journeyOutcome: "missing-recovery",
      onResetRecoveredRecording: () => {
        resets += 1;
      },
      recovered: true,
    })
  );
  expect(
    screen.getByText(
      "We couldn’t find your unfinished recording. It can’t be continued."
    )
  ).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Set up a new recording" })
  );
  expect(resets).toBe(2);
  expect(screen.getAllByRole("status")).toHaveLength(1);
});

it("focuses the terminal alert heading after capture ends", async () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      isRecording: true,
    })
  );
  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      hasStopped: true,
      journeyOutcome: "terminal-restart",
    })
  );

  const heading = screen.getByRole("heading", {
    name: "This recording couldn’t be saved safely",
  });
  await waitFor(() => expect(document.activeElement).toBe(heading));
  expect(screen.getByRole("alert").contains(heading)).toBe(true);
});

const stateScenarios: Array<{
  action: string | null;
  heading: string;
  name: string;
  props: CandidateRecordingJourneyProps;
}> = [
  {
    action: null,
    heading: "Submitting your recording.",
    name: "queued submission",
    props: {
      ...baseProps,
      finalization: { error: null, state: "queued" as const },
      hasStopped: true,
    },
  },
  {
    action: null,
    heading: "Submitting your recording.",
    name: "active submission",
    props: {
      ...baseProps,
      finalization: { error: null, state: "finalizing" as const },
      hasStopped: true,
    },
  },
  {
    action: null,
    heading: "Submission complete.",
    name: "terminal success",
    props: {
      ...baseProps,
      finalization: { error: null, state: "ready" as const },
      hasStopped: true,
    },
  },
  {
    action: "Enable camera and microphone",
    heading:
      "We found an unfinished recording. You can continue where you left off.",
    name: "recovered recording without media permission",
    props: { ...baseProps, recovered: true },
  },
];

for (const scenario of stateScenarios) {
  it(`renders ${scenario.name}`, () => {
    const { unmount } = render(
      React.createElement(CandidateRecordingJourney, scenario.props)
    );
    expect(
      screen.getByRole("heading", { name: scenario.heading })
    ).toBeTruthy();
    if (scenario.action) {
      expect(
        screen.getByRole("button", { name: scenario.action })
      ).toBeTruthy();
      expect(screen.getAllByRole("button").length).toBe(1);
    } else {
      for (const actionName of [
        "Enable camera and microphone",
        "Start recording",
        "Continue recording",
        "Stop recording",
        "Try submitting again",
      ]) {
        expect(screen.queryByRole("button", { name: actionName })).toBe(null);
      }
      expect(screen.queryAllByRole("button").length).toBe(0);
    }
    if (scenario.name === "terminal success") {
      expect(screen.getByText(CLOSE_TAB_PATTERN)).toBeTruthy();
    }
    unmount();
  });
}

it("uses an alert only for a blocking error", () => {
  const { container } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      blockingError: "Camera and microphone access was blocked.",
      blockingErrorTitle: "Camera and microphone access blocked",
    })
  );
  expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
  expect(screen.getByText("Camera and microphone access blocked")).toBeTruthy();
  expect(screen.queryByText("Check your camera and microphone")).toBe(null);
});

it("labels the controls by the active state heading", () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, baseProps)
  );
  let heading = screen.getByRole("heading", {
    name: "Set up your camera and microphone.",
  });
  let controls = screen.getByRole("complementary", {
    name: "Set up your camera and microphone.",
  });
  expect(heading.id).toBe("journey-state-heading");
  expect(controls.getAttribute("aria-labelledby")).toBe(heading.id);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
    })
  );
  heading = screen.getByRole("heading", { name: "You’re ready to record." });
  controls = screen.getByRole("complementary", {
    name: "You’re ready to record.",
  });
  expect(controls.getAttribute("aria-labelledby")).toBe(heading.id);
});

it("keeps automatic saving notices non-alerting and uses approved copy", () => {
  for (const [saveState, message] of [
    ["offline", "Saving will resume when you reconnect."],
    ["retrying", "Keep this screen open; we’ll keep trying."],
    ["error", "Keep this screen open; we’ll keep trying."],
  ] as const) {
    const { container, unmount } = render(
      React.createElement(CandidateRecordingJourney, {
        ...baseProps,
        journeyOutcome: "automatic-retry",
        saveState,
      })
    );
    expect(screen.getByRole("status").textContent).toBe(message);
    expect(container.querySelector('[role="alert"]')).toBe(null);
    unmount();
  }
});

it("uses one persistent async status without a blocking alert", () => {
  const message = "Keep this screen open; we’ll keep trying.";
  const { container } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      journeyOutcome: "automatic-retry",
      savingNotice: message,
    })
  );
  expect(screen.getByRole("status").textContent).toBe(message);
  expect(container.querySelector('[role="alert"]')).toBe(null);
});

it("suppresses a blocking error when submission has failed", () => {
  const { container } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      blockingError: "Camera and microphone access was blocked.",
      finalization: { error: "raw detail", state: "failed" },
      hasStopped: true,
      journeyOutcome: "manual-retry",
    })
  );
  expect(screen.queryByText("Camera and microphone access was blocked.")).toBe(
    null
  );
  expect(
    screen.getByText(RECORDING_DELIVERY_COPY.finalizationFailure)
  ).toBeTruthy();
  expect(container.querySelectorAll('[role="alert"]').length).toBe(1);
});

it("announces honestly without invented progress or implementation language", () => {
  const honestyScenarios: CandidateRecordingJourneyProps[] = [
    baseProps,
    { ...baseProps, isReady: true },
    { ...baseProps, isReady: true, isRecording: true },
    { ...baseProps, recovered: true },
    {
      ...baseProps,
      finalization: { error: null, state: "queued" },
      hasStopped: true,
    },
    {
      ...baseProps,
      finalization: { error: null, state: "finalizing" },
      hasStopped: true,
    },
    {
      ...baseProps,
      finalization: { error: "hidden raw detail", state: "failed" },
      hasStopped: true,
      journeyOutcome: "manual-retry",
    },
    {
      ...baseProps,
      finalization: { error: null, state: "ready" },
      hasStopped: true,
    },
  ];

  for (const props of honestyScenarios) {
    const { container, unmount } = render(
      React.createElement(CandidateRecordingJourney, props)
    );
    expect(screen.getAllByRole("status")).toHaveLength(1);
    expect(screen.queryByRole("progressbar")).toBe(null);
    expect((container.textContent ?? "").includes("%")).toBe(false);
    expect(
      IMPLEMENTATION_LANGUAGE_PATTERN.test(container.textContent ?? "")
    ).toBe(false);
    unmount();
  }
});

it("moves focus through explicit recording state changes", async () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, baseProps)
  );

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
    })
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Start recording" })
    )
  );

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      isRecording: true,
    })
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Stop recording" })
    )
  );

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: null, state: "queued" },
      hasStopped: true,
    })
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", { name: "Submitting your recording." })
    )
  );

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: "hidden raw detail", state: "failed" },
      hasStopped: true,
      journeyOutcome: "manual-retry",
    })
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("heading", {
        name: "Submission needs attention",
      })
    )
  );
  expect(screen.getByRole("alert")).toBeTruthy();
});

it("focuses Continue recording after recovered media becomes ready", async () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      recovered: true,
    })
  );
  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      recovered: true,
    })
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      screen.getByRole("button", { name: "Continue recording" })
    )
  );
});

it("uses finite pending labels and disables each action", () => {
  const pendingScenarios: Array<{
    label: string;
    props: CandidateRecordingJourneyProps;
  }> = [
    {
      label: "Enabling camera and microphone…",
      props: { ...baseProps, pendingAction: "initialize" },
    },
    {
      label: "Starting recording…",
      props: { ...baseProps, isReady: true, pendingAction: "start" },
    },
    {
      label: "Stopping recording…",
      props: {
        ...baseProps,
        isReady: true,
        isRecording: true,
        pendingAction: "stop",
      },
    },
    {
      label: "Trying to submit…",
      props: {
        ...baseProps,
        finalization: { error: "hidden", state: "failed" },
        hasStopped: true,
        journeyOutcome: "manual-retry",
        pendingAction: "retry",
      },
    },
  ];

  for (const scenario of pendingScenarios) {
    const { unmount } = render(
      React.createElement(CandidateRecordingJourney, scenario.props)
    );
    const button = screen.getByRole("button", { name: scenario.label });
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(screen.getAllByRole("button").length).toBe(1);
    unmount();
  }
});

it("connects a stream to an accessible inline camera preview", () => {
  const stream = {} as MediaStream;
  render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      stream,
    })
  );
  const video = screen.getByLabelText(
    "Your camera preview"
  ) as HTMLVideoElement;
  expect(video.srcObject).toBe(stream);
  expect(video.autoplay).toBe(true);
  expect(video.muted).toBe(true);
  expect(video.playsInline).toBe(true);
});

it("capture ended overrides a stale recording flag and focuses submission", async () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      isRecording: true,
    })
  );
  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      hasStopped: true,
      isRecording: true,
    })
  );
  const heading = screen.getByRole("heading", {
    name: "Submitting your recording.",
  });
  await waitFor(() => expect(document.activeElement).toBe(heading));
});

it("blocks only Start and Continue when beginning capture is unsafe", () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      blockingError: "This browser can’t save your recording safely right now.",
      blockingErrorTitle: "Recording can’t be saved",
      captureBlocked: true,
      isReady: true,
    })
  );
  expect(
    screen
      .getByRole("button", { name: "Start recording" })
      .hasAttribute("disabled")
  ).toBe(true);
  expect(screen.getByRole("alert")).toBeTruthy();

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      blockingError:
        "We found a problem with your recording that needs attention.",
      blockingErrorTitle: "Recording needs attention",
      captureBlocked: true,
      isReady: true,
      recovered: true,
    })
  );
  expect(
    screen
      .getByRole("button", { name: "Continue recording" })
      .hasAttribute("disabled")
  ).toBe(true);
  expect(screen.getByRole("alert")).toBeTruthy();
});

function renderJourney(
  overrides: Partial<CandidateRecordingJourneyProps> = {}
) {
  return render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      ...overrides,
    })
  );
}

it.each([
  [
    "checking",
    "idle",
    "Checking that this device is ready to record for up to 30 minutes offline.",
  ],
  [
    "ready",
    "idle",
    "This device is ready to protect up to 30 minutes of recording if you temporarily lose connection.",
  ],
  ["ready", "saving", "Your recording is being saved."],
  [
    "ready",
    "offline",
    "You’re offline. Your recording is still being saved on this device.",
  ],
  ["ready", "reconnecting", "Connection restored. Saving your recording."],
  ["ready", "retrying", "Connection trouble. We’ll keep trying."],
] as const)("announces %s/%s once", (preflight, delivery, message) => {
  renderJourney({
    recordingDeliveryPhase: delivery,
    recordingPreflightState: preflight,
  });
  expect(screen.getByRole("status").textContent).toBe(message);
  expect(screen.queryAllByRole("status")).toHaveLength(1);
  expect(screen.queryByRole("alert")).toBeNull();
});

it("alerts on blocked preflight and offers Try again without Start", () => {
  const retries: string[] = [];
  renderJourney({
    onRetryPreflight: () => {
      retries.push("retry");
    },
    recordingPreflightState: "blocked",
  });
  expect(screen.getByRole("alert").textContent ?? "").toContain(
    RECORDING_DELIVERY_COPY.preflightBlocked
  );
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(
    screen.queryByRole("button", { name: START_BUTTON_PATTERN })
  ).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: TRY_AGAIN_PATTERN }));
  expect(retries).toEqual(["retry"]);
});

it("does not duplicate the blocked-preflight alert when the route hands off the same copy", () => {
  renderJourney({
    blockingError: RECORDING_DELIVERY_COPY.preflightBlocked,
    blockingErrorTitle: "This device isn’t ready to record",
    recordingPreflightState: "blocked",
  });
  expect(screen.getAllByRole("alert")).toHaveLength(1);
  expect(screen.getByRole("alert").textContent ?? "").toContain(
    RECORDING_DELIVERY_COPY.preflightBlocked
  );
});

it("alerts on device write failure", () => {
  renderJourney({
    hasStopped: true,
    journeyOutcome: "terminal-restart",
    recordingStopReason: "save-failure",
  });
  expect(screen.getByRole("alert").textContent ?? "").toContain(
    RECORDING_DELIVERY_COPY.saveFailure
  );
});

it("alerts on finalization failure", () => {
  renderJourney({
    finalization: { error: "hidden", state: "failed" },
    hasStopped: true,
    journeyOutcome: "manual-retry",
  });
  expect(
    screen.getByText(RECORDING_DELIVERY_COPY.finalizationFailure)
  ).toBeTruthy();
});

it("treats a failed finalization as a retryable alert even without a journey outcome", () => {
  renderJourney({
    finalization: { error: "hidden", state: "failed" },
    hasStopped: true,
  });
  expect(screen.getByRole("alert").textContent ?? "").toContain(
    RECORDING_DELIVERY_COPY.finalizationFailure
  );
  expect(
    screen.getByRole("button", { name: RETRY_SUBMIT_PATTERN })
  ).toBeTruthy();
});

it("announces candidate Stop while unsent media remains", () => {
  renderJourney({
    hasStopped: true,
    hasUnsentRecordingMedia: true,
    recordingPreflightState: "ready",
    recordingStopReason: "candidate",
  });
  expect(screen.getByRole("status").textContent).toBe(
    RECORDING_DELIVERY_COPY.candidateStop
  );
  expect(screen.queryByRole("alert")).toBeNull();
});

it.each(["queued", "finalizing"] as const)(
  "announces completion pending while finalization is %s",
  (state) => {
    renderJourney({
      finalization: { error: null, state },
      hasIncompleteRecordingFinalization: true,
      hasStopped: true,
    });
    expect(screen.getByRole("status").textContent).toBe(
      RECORDING_DELIVERY_COPY.completionPending
    );
  }
);

it("keeps a capacity safety-stop as status without retry", () => {
  renderJourney({
    hasStopped: true,
    recordingStopReason: "capacity",
  });
  expect(screen.getByRole("status").textContent).toBe(
    RECORDING_DELIVERY_COPY.capacity
  );
  expect(screen.queryByRole("alert")).toBeNull();
  expect(screen.queryByRole("button", { name: TRY_AGAIN_PATTERN })).toBeNull();
});

it("does not expose progress UI or implementation terminology", () => {
  const { container } = renderJourney({
    isReady: true,
    recordingDeliveryPhase: "saving",
    recordingPreflightState: "ready",
  });
  expect(screen.queryByRole("progressbar")).toBeNull();
  expect(container.textContent ?? "").not.toMatch(IMPLEMENTATION_TERM_PATTERN);
  expect((container.textContent ?? "").includes("%")).toBe(false);
});
