import { defineConfig } from "@playwright/test";

const isCi = Boolean(process.env.CI);

export default defineConfig({
  forbidOnly: isCi,
  reporter: isCi ? [["github"], ["html", { open: "never" }]] : "list",
  retries: isCi ? 2 : 0,
  testDir: "./tests/e2e",
  use: {
    baseURL: "http://127.0.0.1:3001",
    trace: "on-first-retry",
  },
  webServer: {
    command: "pnpm dev:bare --host 127.0.0.1",
    reuseExistingServer: !isCi,
    timeout: 120_000,
    url: "http://127.0.0.1:3001",
  },
});
