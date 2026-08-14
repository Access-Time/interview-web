import { expect, type Page, test } from "@playwright/test";
import {
  createCandidateBindings,
  installMediaRecorder,
  installRecordingApi,
} from "./recording-fixture";

const CAMERA_OFF_COPY =
  "Your camera and microphone are off. Keep this screen open until submission is complete.";
const RECORDING_GUIDANCE =
  "Keep this screen open and stay in this browser while you record.";
const NEW_RECORDING_PATTERN = /start a new recording/i;
const RETRYABLE_UPLOAD_PATTERN = /upload|saving is delayed|keep trying/i;

async function installCandidateMedia(page: Page) {
  await page.addInitScript(() => {
    if (!navigator.mediaDevices) {
      Object.defineProperty(navigator, "mediaDevices", {
        configurable: true,
        value: {},
      });
    }
  });
  await installMediaRecorder(page);
}

async function startRecording(page: Page) {
  await page.waitForFunction(async () =>
    (await indexedDB.databases()).some(
      (database) => database.name === "live-recording-outbox"
    )
  );
  await page.waitForFunction(() => {
    const button = document.querySelector("button");
    return Boolean(
      button &&
        Object.keys(button).some((key) => key.startsWith("__reactProps"))
    );
  });
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
  await expect(page.getByLabel("Your camera preview")).toBeVisible();
  await start.click();
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
    "Keep this screen open; we’ll keep trying."
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
  ).toBeVisible();
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
    "Saving will resume when you reconnect."
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
  await expect(page.getByRole("status")).toHaveCount(1);
  await expect(page.getByRole("status")).toHaveText(
    "Your recording is still here. Check your connection, then try again."
  );
  const retry = page.getByRole("button", { name: "Try submitting again" });
  await expect(retry).toBeVisible();
  await retry.click();
  await expect(page.getByText(CAMERA_OFF_COPY)).toBeVisible();
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
    "Keep this screen open; we’ll keep trying."
  );
  fixture.markAllReady();

  await expect(
    page.getByRole("heading", { name: "Submission complete." })
  ).toBeVisible({ timeout: 5000 });
  await expect(
    page.getByRole("button", { name: NEW_RECORDING_PATTERN })
  ).toHaveCount(0);
  await expect(page.getByRole("status")).toHaveText("");
});
