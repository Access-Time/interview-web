import { expect, test } from "@playwright/test";
import {
  createCandidateBindings,
  installMediaRecorder,
  installRecordingApi,
} from "./recording-fixture";

test("shows candidate recording setup", async ({ page }) => {
  const fixture = createCandidateBindings();
  await installMediaRecorder(page);
  await installRecordingApi(page, fixture);
  await page.goto("/");

  await expect(
    page.getByRole("button", { name: "Enable camera and microphone" })
  ).toBeVisible();
});
