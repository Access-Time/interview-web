import { expect, type Page, test } from "@playwright/test";
import {
  createCandidateBindings,
  installMediaRecorder,
  installRecordingApi,
  installRecordingFixture,
  installRecordingStorage,
  reconnectRecordingFixture,
} from "./recording-fixture";

const CAMERA_OFF_COPY =
  "Your camera and microphone are off. Keep this screen open until submission is complete.";
const RECORDING_GUIDANCE =
  "Keep this screen open and stay in this browser while you record.";
const NEW_RECORDING_PATTERN = /start a new recording/i;
const RETRYABLE_UPLOAD_PATTERN = /upload|saving is delayed|keep trying/i;
const START_BUTTON_PATTERN = /start/i;
const STOP_BUTTON_PATTERN = /stop/i;
const TRY_AGAIN_PATTERN = /try again/i;
const RESUME_SAVING_PATTERN =
  /Connection restored\. Saving your recording\.|Your recording is being saved\./;

async function installCandidateMedia(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
    }
  });
  await installRecordingStorage(page);
  await installMediaRecorder(page);
}

async function waitForRecordingApp(page: Page) {
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "live-recording-outbox"
    )
  );
  await page.evaluate(() => {
    const streamKey = Symbol("test-src-object");
    Object.defineProperty(HTMLMediaElement.prototype, "srcObject", {
      configurable: true,
      get() {
        return Reflect.get(this, streamKey) ?? null;
      },
      set(value) {
        Reflect.set(this, streamKey, value);
      },
    });
  });
}

async function prepareReadyRecording(page: Page) {
  await waitForRecordingApp(page);
  const enable = page.getByRole("button", {
    name: "Enable camera and microphone",
  });
  const start = page.getByRole("button", { name: "Start recording" });
  await expect(async () => {
    if (await enable.isVisible()) {
      await enable.click();
    }
    await expect(start).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 5000 });
  await expect(
    page.getByText(
      "This device is ready to protect up to 30 minutes of recording if you temporarily lose connection."
    )
  ).toBeVisible();
  await expect(page.getByLabel("Your camera preview")).toBeVisible();
}

async function startRecording(page: Page) {
  await prepareReadyRecording(page);
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByText(RECORDING_GUIDANCE)).toBeVisible();
}

async function seedMissingRecovery(page: Page) {
  await page.evaluate(
    () =>
      new Promise<void>((resolve, reject) => {
        const request = indexedDB.open("live-recording-outbox", 2);
        request.onupgradeneeded = () => {
          const database = request.result;
          if (!database.objectStoreNames.contains("parts")) {
            database.createObjectStore("parts", { keyPath: "id" });
          }
          if (!database.objectStoreNames.contains("sessions")) {
            database.createObjectStore("sessions", { keyPath: "sessionId" });
          }
        };
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const transaction = request.result.transaction(
            ["parts", "sessions"],
            "readwrite"
          );
          transaction.objectStore("sessions").put({
            recorderMimeType: "video/webm",
            requestedMimeType: "video/webm",
            segments: [{ partCount: 1, segmentId: "local-segment" }],
            sessionId: "missing-recording",
            status: "recording",
          });
          transaction.objectStore("parts").put({
            blob: new Blob(["retained recording"]),
            id: "missing-recording:local-segment:0",
            mediaType: "video/webm",
            segmentId: "local-segment",
            sequence: 0,
            sessionId: "missing-recording",
          });
          transaction.oncomplete = () => resolve();
          transaction.onerror = () => reject(transaction.error);
        };
      })
  );
}

test("normal stop releases media and submits without a restart action", async ({
  page,
}) => {
  const fixture = createCandidateBindings();
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");
  await startRecording(page);

  await page.getByRole("button", { name: "Stop recording" }).click();

  await expect(page.getByText(CAMERA_OFF_COPY)).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.__recordingTestState.stoppedTracks))
    .toBe(2);
  await expect(
    page.getByRole("button", { name: NEW_RECORDING_PATTERN })
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText(
    "Your recording is saved. We’re completing it now."
  );
});

test("fatal upload clears capture without retryable upload wording", async ({
  page,
}) => {
  const fixture = createCandidateBindings();
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture, 400);
  await page.goto("/");
  await startRecording(page);

  await page.getByRole("button", { name: "Stop recording" }).click();

  await expect(
    page.getByText(
      "Your camera and microphone are off. We couldn’t save this recording safely."
    )
  ).toBeVisible({ timeout: 10_000 });
  await expect(page.getByLabel("Your camera preview")).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(() => window.__recordingTestState.stoppedTracks))
    .toBe(2);
  await expect(page.getByText(RETRYABLE_UPLOAD_PATTERN)).toHaveCount(0);
});

test("offline saving exposes one async status", async ({ page }) => {
  const fixture = createCandidateBindings();
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");
  await startRecording(page);
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));

  await page.getByRole("button", { name: "Stop recording" }).click();

  await expect(page.getByRole("status")).toHaveText(
    "You’re offline. Your recording is still being saved on this device."
  );
  await expect(page.getByRole("status")).toHaveCount(1);
});

test("failed finalization offers a manual retry", async ({ page }) => {
  const fixture = createCandidateBindings();
  let attempts = 0;
  fixture.bindings.finalizeRecording = () => {
    attempts += 1;
    if (attempts === 1) {
      return Promise.reject(new Error("finalization unavailable"));
    }
    return Promise.resolve({ status: "queued" });
  };
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");
  await startRecording(page);

  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByText(CAMERA_OFF_COPY)).toBeVisible();
  await expect(page.getByRole("status")).toHaveCount(1);
  const retry = page.getByRole("button", { name: "Try submitting again" });
  if (await retry.isVisible()) {
    await retry.click();
    await expect(page.getByText(CAMERA_OFF_COPY)).toBeVisible();
  }
});

test("mobile recording keeps foreground and browser guidance visible", async ({
  page,
}) => {
  const fixture = createCandidateBindings();
  await page.setViewportSize({ height: 844, width: 390 });
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");

  await startRecording(page);

  await expect(page.getByText(RECORDING_GUIDANCE)).toBeVisible();
});

test("typed missing recovery resets to normal setup", async ({ page }) => {
  const fixture = createCandidateBindings();
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");
  await seedMissingRecovery(page);
  await page.reload();

  await expect(
    page.getByText(
      "We couldn’t find your unfinished recording. It can’t be continued."
    )
  ).toBeVisible();
  await page.getByRole("button", { name: "Set up a new recording" }).click();
  await expect(
    page.getByRole("button", { name: "Enable camera and microphone" })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Start a new recording" })
  ).toHaveCount(0);
});

test("queued finalization reaches completion when it becomes ready", async ({
  page,
}) => {
  const fixture = createCandidateBindings();
  await installCandidateMedia(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");
  await startRecording(page);

  await page.getByRole("button", { name: "Stop recording" }).click();
  await expect(page.getByText(CAMERA_OFF_COPY)).toBeVisible();
  await expect(page.getByRole("status")).toHaveText(
    "Your recording is saved. We’re completing it now."
  );
  fixture.markAllReady();
  await expect(
    page.getByRole("heading", { name: "Submission complete." })
  ).toBeVisible();
  await expect(
    page.getByText("Your recording is saved. We’re completing it now.")
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: NEW_RECORDING_PATTERN })
  ).toHaveCount(0);
});

test("blocks Start when the device cannot pass the offline recovery check", async ({
  page,
}) => {
  await installRecordingFixture(page, {
    storage: { persisted: false, persistResult: false, quota: 100, usage: 0 },
  });
  await page.goto("/");
  await waitForRecordingApp(page);
  await page.evaluate(() => {
    Object.assign(navigator.storage, {
      estimate: async () => ({ quota: 100, usage: 0 }),
      persist: async () => false,
      persisted: async () => false,
    });
  });
  const enable = page.getByRole("button", {
    name: "Enable camera and microphone",
  });
  const blockedCopy =
    "This device isn’t ready to safely store a recording offline. Check your storage or browser, then try again.";
  await expect(async () => {
    if (await enable.isVisible()) {
      await enable.click();
    }
    await expect(page.getByRole("alert")).toContainText(blockedCopy, {
      timeout: 500,
    });
  }).toPass({ timeout: 8000 });
  await expect(page.getByRole("alert")).toHaveCount(1);
  await expect(
    page.getByRole("button", { name: START_BUTTON_PATTERN })
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: TRY_AGAIN_PATTERN })
  ).toBeVisible();
});

test("keeps recording offline and resumes saving after reconnect", async ({
  page,
}) => {
  const { upload } = await installRecordingFixture(page, {
    upload: { mode: "offline" },
  });
  await page.goto("/");
  await startRecording(page);
  await page.evaluate(() => window.__testMediaRecorder?.emitPart());
  await page.evaluate(() => window.dispatchEvent(new Event("offline")));
  await expect(page.getByRole("status")).toHaveText(
    "You’re offline. Your recording is still being saved on this device."
  );
  await expect(
    page.getByRole("button", { name: STOP_BUTTON_PATTERN })
  ).toBeVisible();
  await reconnectRecordingFixture(page, upload);
  await expect(page.getByRole("status")).toHaveText(RESUME_SAVING_PATTERN);
});

test("shows finishing copy while durable parts drain after Stop", async ({
  page,
}) => {
  await installRecordingFixture(page, { upload: { mode: "offline" } });
  await page.goto("/");
  await startRecording(page);
  await page.evaluate(() => window.__testMediaRecorder?.emitPart());
  await page.getByRole("button", { name: STOP_BUTTON_PATTERN }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your camera and microphone are off. Finishing your recording."
  );
});

test("shows completion pending until finalization is ready", async ({
  page,
}) => {
  const { fixture } = await installRecordingFixture(page, {
    finalization: "pending",
  });
  await page.goto("/");
  await startRecording(page);
  await page.getByRole("button", { name: STOP_BUTTON_PATTERN }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your recording is saved. We’re completing it now."
  );
  fixture.markAllReady();
  await expect(
    page.getByRole("heading", { name: "Submission complete." })
  ).toBeVisible();
  await expect(
    page.getByText("Your recording is saved. We’re completing it now.")
  ).toHaveCount(0);
});

test("a local save failure turns hardware off without a misleading retry", async ({
  page,
}) => {
  await installRecordingFixture(page, {
    storage: { writeFailsAfterPart: 1 },
    upload: { mode: "offline" },
  });
  await page.goto("/");
  await startRecording(page);
  await page.evaluate(() => window.__testMediaRecorder?.emitPart("first"));
  await page.evaluate(() => window.__testMediaRecorder?.emitPart("second"));
  await expect(page.getByRole("alert")).toContainText(
    "We couldn’t save this recording safely. Your camera and microphone are off. Contact the hiring team for help."
  );
  await expect
    .poll(() => page.evaluate(() => window.__recordingTestState.stoppedTracks))
    .toBe(2);
  await expect(
    page.getByRole("button", { name: TRY_AGAIN_PATTERN })
  ).toHaveCount(0);
});

test("capacity safety-stop stays a status and still completes", async ({
  page,
}) => {
  const { fixture } = await installRecordingFixture(page);
  await page.goto("/");
  await startRecording(page);
  await page.evaluate(() => {
    window.__recordingTestStorage = { quota: 64_860_000, usage: 0 };
    window.__testMediaRecorder?.emitPart();
  });
  await expect(page.getByRole("status")).toHaveText(
    "We stopped recording to protect your saved recording. Finishing it now."
  );
  await expect(page.getByRole("alert")).toHaveCount(0);
  await expect(async () => {
    fixture.markAllReady();
    await expect(
      page.getByRole("heading", { name: "Submission complete." })
    ).toBeVisible({ timeout: 500 });
  }).toPass({ timeout: 8000 });
  await expect(
    page.getByText(
      "We stopped recording to protect your saved recording. Finishing it now."
    )
  ).toHaveCount(0);
});

test("keeps a single status region on desktop and mobile", async ({ page }) => {
  await installRecordingFixture(page);
  await page.goto("/");
  await startRecording(page);
  await expect(page.getByRole("status")).toHaveCount(1);
  await page.setViewportSize({ height: 844, width: 390 });
  await expect(page.getByRole("status")).toHaveCount(1);
});

test("rechecks preflight immediately before Start", async ({ page }) => {
  const { fixture } = await installRecordingFixture(page);
  await page.goto("/");
  await prepareReadyRecording(page);
  await page.evaluate(() => {
    window.__recordingTestStorage = { quota: 10, usage: 9 };
  });
  await page.getByRole("button", { name: "Start recording" }).click();
  await expect(page.getByRole("alert")).toContainText(
    "This device isn’t ready to safely store a recording offline"
  );
  expect(fixture.createCallCount()).toBe(0);
  await expect(
    page.getByRole("button", { name: TRY_AGAIN_PATTERN })
  ).toBeVisible();
});

test("waits for delayed recovery before creating a session", async ({
  page,
}) => {
  const { fixture } = await installRecordingFixture(page);
  const manifest = fixture.deferManifest("missing-recording");
  await page.goto("/");
  await seedMissingRecovery(page);
  await page.reload();
  await expect.poll(() => fixture.createCallCount()).toBe(0);
  manifest.resolve({
    createdAt: Date.now(),
    segments: [
      {
        createdAt: Date.now(),
        id: "local-segment",
        index: 0,
        parts: [],
        recorderMimeType: "video/webm",
        requestedMimeType: "video/webm",
      },
    ],
    sessionId: "missing-recording",
  });
  await expect(
    page.getByRole("heading", {
      name: "We found an unfinished recording. You can continue where you left off.",
    })
  ).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Enable camera and microphone" })
  ).toBeVisible();
});

test("deduplicates rapid Start clicks while creation is pending", async ({
  page,
}) => {
  const { fixture } = await installRecordingFixture(page);
  const creation = fixture.deferCreate();
  await page.goto("/");
  await prepareReadyRecording(page);
  const start = page.getByRole("button", { name: "Start recording" });
  const startButton = await start.elementHandle();
  await start.click();
  await startButton?.evaluate((button) =>
    (button as HTMLButtonElement).click()
  );
  await expect.poll(() => fixture.createCallCount()).toBe(1);
  creation.resolve();
  await expect(page.getByText(RECORDING_GUIDANCE)).toBeVisible();
});

test("persists and uploads the terminal capacity part before completion", async ({
  page,
}) => {
  const { fixture } = await installRecordingFixture(page);
  await page.goto("/");
  await startRecording(page);
  await page.evaluate(() => {
    window.__recordingTestStorage = { quota: 64_860_000, usage: 0 };
    window.__testMediaRecorder?.emitPart();
  });
  await expect(page.getByRole("status")).toHaveText(
    "We stopped recording to protect your saved recording. Finishing it now."
  );
  await expect.poll(() => fixture.uploadedPartCount()).toBe(2);
  await expect(
    page.getByRole("heading", { name: "Submission complete." })
  ).toHaveCount(0);
  fixture.markAllReady();
  await expect(
    page.getByRole("heading", { name: "Submission complete." })
  ).toBeVisible();
});

test("shows manual retry after polled finalization failure", async ({
  page,
}) => {
  const { fixture } = await installRecordingFixture(page, {
    finalization: "pending",
  });
  await page.goto("/");
  await startRecording(page);
  await page.getByRole("button", { name: STOP_BUTTON_PATTERN }).click();
  await expect(page.getByRole("status")).toHaveText(
    "Your recording is saved. We’re completing it now."
  );
  fixture.markAllFailed();
  await expect(page.getByRole("alert")).toContainText(
    "Submission needs attention"
  );
  await expect(
    page.getByRole("button", { name: "Try submitting again" })
  ).toBeEnabled();
});
