import assert from "node:assert/strict";
import { afterEach, test } from "node:test";
// @ts-expect-error jsdom ships no declarations in this workspace.
import { JSDOM } from "jsdom";
import React from "react";
import type { CandidateRecordingJourneyProps } from "../src/recording/candidate-recording-journey";

const CLOSE_TAB_PATTERN = /may close this tab/i;
const IMPLEMENTATION_LANGUAGE_PATTERN =
  /\b(session|raw|storage|server|segment|part|queue|acknowledged|finalization|retrieve)\b/i;

const dom = new JSDOM("<!doctype html><html><body></body></html>", {
  url: "http://localhost",
});

Object.defineProperties(globalThis, {
  document: { configurable: true, value: dom.window.document },
  Event: { configurable: true, value: dom.window.Event },
  HTMLElement: { configurable: true, value: dom.window.HTMLElement },
  IS_REACT_ACT_ENVIRONMENT: {
    configurable: true,
    value: true,
    writable: true,
  },
  navigator: { configurable: true, value: dom.window.navigator },
  window: { configurable: true, value: dom.window },
});

window.matchMedia = () =>
  ({
    addEventListener: () => undefined,
    dispatchEvent: () => false,
    matches: false,
    media: "",
    onchange: null,
    removeEventListener: () => undefined,
  }) as unknown as MediaQueryList;

globalThis.ResizeObserver = class {
  disconnect() {
    /* Browser fake. */
  }
  observe() {
    /* Browser fake. */
  }
  unobserve() {
    /* Browser fake. */
  }
} as typeof ResizeObserver;

const { cleanup, fireEvent, render, screen, waitFor } = await import(
  "@testing-library/react"
);
const { CandidateRecordingJourney } = await import(
  "../src/recording/candidate-recording-journey"
);

const baseProps: CandidateRecordingJourneyProps = {
  blockingError: null,
  blockingErrorTitle: null,
  finalization: null,
  hasStopped: false,
  isReady: false,
  isRecording: false,
  onInitialize: () => undefined,
  onRetry: () => undefined,
  onStart: () => undefined,
  onStop: () => undefined,
  pendingAction: null,
  recovered: false,
  saveState: "healthy",
  savingNotice: null,
  stream: null,
};

afterEach(() => {
  cleanup();
});

test("shows one candidate action for each active primary state", () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, baseProps)
  );
  assert.ok(
    screen.getByRole("heading", {
      name: "Set up your camera and microphone.",
    })
  );
  assert.ok(
    screen.getByRole("button", { name: "Enable camera and microphone" })
  );
  assert.equal(screen.getAllByRole("button").length, 1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
    })
  );
  assert.ok(screen.getByRole("heading", { name: "You’re ready to record." }));
  assert.ok(screen.getByRole("button", { name: "Start recording" }));
  assert.equal(screen.getAllByRole("button").length, 1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      isReady: true,
      isRecording: true,
    })
  );
  assert.ok(screen.getByText("Recording"));
  assert.ok(screen.getByRole("button", { name: "Stop recording" }));
  assert.equal(screen.getAllByRole("button").length, 1);
});

test("continues a recovered recording and retries a failed submission", () => {
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
  assert.equal(starts, 1);
  assert.equal(screen.getAllByRole("button").length, 1);

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: "failed", state: "failed" },
      hasStopped: true,
      onRetry: () => {
        retries += 1;
      },
    })
  );
  fireEvent.click(screen.getByRole("button", { name: "Try submitting again" }));
  assert.equal(retries, 1);
  assert.equal(screen.getAllByRole("button").length, 1);
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
  test(`renders ${scenario.name}`, () => {
    const { unmount } = render(
      React.createElement(CandidateRecordingJourney, scenario.props)
    );
    assert.ok(screen.getByRole("heading", { name: scenario.heading }));
    if (scenario.action) {
      assert.ok(screen.getByRole("button", { name: scenario.action }));
      assert.equal(screen.getAllByRole("button").length, 1);
    } else {
      for (const actionName of [
        "Enable camera and microphone",
        "Start recording",
        "Continue recording",
        "Stop recording",
        "Try submitting again",
      ]) {
        assert.equal(screen.queryByRole("button", { name: actionName }), null);
      }
      assert.equal(screen.queryAllByRole("button").length, 0);
    }
    if (scenario.name === "terminal success") {
      assert.ok(screen.getByText(CLOSE_TAB_PATTERN));
    }
    unmount();
  });
}

test("uses an alert only for a blocking error", () => {
  const { container } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      blockingError: "Camera and microphone access was blocked.",
      blockingErrorTitle: "Camera and microphone access blocked",
    })
  );
  assert.equal(container.querySelectorAll('[role="alert"]').length, 1);
  assert.ok(screen.getByText("Camera and microphone access blocked"));
  assert.equal(screen.queryByText("Check your camera and microphone"), null);
});

test("labels the controls by the active state heading", () => {
  const { rerender } = render(
    React.createElement(CandidateRecordingJourney, baseProps)
  );
  let heading = screen.getByRole("heading", {
    name: "Set up your camera and microphone.",
  });
  let controls = screen.getByRole("complementary", {
    name: "Set up your camera and microphone.",
  });
  assert.equal(heading.id, "journey-state-heading");
  assert.equal(controls.getAttribute("aria-labelledby"), heading.id);

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
  assert.equal(controls.getAttribute("aria-labelledby"), heading.id);
});

test("keeps saving notices non-alerting and uses the approved copy", () => {
  for (const [saveState, message] of [
    [
      "offline",
      "You’re offline. Keep this tab open; we’ll continue when your connection returns.",
    ],
    ["retrying", "Saving is delayed. Keep this tab open while we try again."],
    [
      "error",
      "Saving needs attention. Keep this tab open and check your connection.",
    ],
  ] as const) {
    const { container, unmount } = render(
      React.createElement(CandidateRecordingJourney, {
        ...baseProps,
        saveState,
      })
    );
    assert.ok(screen.getByText(message));
    assert.equal(container.querySelector('[role="alert"]'), null);
    unmount();
  }
});

test("shows a saving network notice once without a blocking alert", () => {
  const message =
    "Saving needs attention. Keep this tab open and check your connection.";
  const { container } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      savingNotice: message,
    })
  );
  assert.equal(screen.getAllByText(message).length, 1);
  assert.equal(container.querySelector('[role="alert"]'), null);
});

test("suppresses a blocking error when submission has failed", () => {
  const { container } = render(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      blockingError: "Camera and microphone access was blocked.",
      finalization: { error: "raw detail", state: "failed" },
      hasStopped: true,
    })
  );
  assert.equal(
    screen.queryByText("Camera and microphone access was blocked."),
    null
  );
  assert.equal(container.querySelectorAll('[role="alert"]').length, 0);
});

test("announces honestly without invented progress or implementation language", () => {
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
    const liveRegions = container.querySelectorAll(
      '[aria-live="polite"][aria-atomic="true"]'
    );
    assert.equal(liveRegions.length, 1);
    assert.equal(screen.queryByRole("progressbar"), null);
    assert.equal((container.textContent ?? "").includes("%"), false);
    assert.equal(
      IMPLEMENTATION_LANGUAGE_PATTERN.test(container.textContent ?? ""),
      false
    );
    unmount();
  }
});

test("moves focus through explicit recording state changes", async () => {
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
    assert.equal(
      document.activeElement,
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
    assert.equal(
      document.activeElement,
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
    assert.equal(
      document.activeElement,
      screen.getByRole("heading", { name: "Submitting your recording." })
    )
  );

  rerender(
    React.createElement(CandidateRecordingJourney, {
      ...baseProps,
      finalization: { error: "hidden raw detail", state: "failed" },
      hasStopped: true,
    })
  );
  await waitFor(() =>
    assert.equal(
      document.activeElement,
      screen.getByRole("heading", {
        name: "Your recording is saved, but we couldn’t finish submitting it.",
      })
    )
  );
  assert.equal(screen.queryByRole("alert"), null);
});

test("focuses Continue recording after recovered media becomes ready", async () => {
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
    assert.equal(
      document.activeElement,
      screen.getByRole("button", { name: "Continue recording" })
    )
  );
});

test("uses finite pending labels and disables each action", () => {
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
        pendingAction: "retry",
      },
    },
  ];

  for (const scenario of pendingScenarios) {
    const { unmount } = render(
      React.createElement(CandidateRecordingJourney, scenario.props)
    );
    const button = screen.getByRole("button", { name: scenario.label });
    assert.equal(button.hasAttribute("disabled"), true);
    assert.equal(screen.getAllByRole("button").length, 1);
    unmount();
  }
});

test("connects a stream to an accessible inline camera preview", () => {
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
  assert.equal(video.srcObject, stream);
  assert.equal(video.autoplay, true);
  assert.equal(video.muted, true);
  assert.equal(video.playsInline, true);
});
