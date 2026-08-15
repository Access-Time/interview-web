import { expect, it } from "vitest";
import {
  getRecordingStoragePolicy,
  runRecordingPreflight,
  wouldBreachRecordingCapacity,
} from "../src/recording/recording-admission.ts";

const validPolicy = getRecordingStoragePolicy(128_000, 1_000_000);
if (!validPolicy) {
  throw new Error("expected a usable recording storage policy");
}

const storage = (
  estimate: { quota?: number; usage?: number },
  persist = true,
  persisted = true
) => ({
  estimate: async () => estimate,
  persist: async () => persist,
  persisted: async () => persisted,
});

const dependencies = (
  options: {
    estimate?: { quota?: number; usage?: number };
    persist?: boolean;
    persisted?: boolean;
    probe?: () => Promise<void>;
    storage?: null;
  } = {}
) => ({
  probe: options.probe ?? (() => Promise.resolve()),
  storage:
    options.storage === null
      ? null
      : storage(
          options.estimate ?? { quota: 1_000_000_000, usage: 10 },
          options.persist,
          options.persisted
        ),
});

it("calculates the 30-minute target, margin, and five-second prediction", () => {
  expect(validPolicy).toEqual({
    predictedPartBytes: 705_000,
    recoveryTargetBytes: 253_800_000,
    safetyMarginBytes: 63_450_000,
  });
});

it.each([
  [0, 1_000_000],
  [Number.NaN, 1_000_000],
  [128_000, Number.POSITIVE_INFINITY],
  [Number.MAX_VALUE, Number.MAX_VALUE],
])("rejects invalid recorder bitrate input", (audio, video) => {
  expect(getRecordingStoragePolicy(audio, video)).toBeNull();
});

it("rejects finite positive bitrates whose derived bytes overflow", () => {
  const bitrate = Number.MAX_VALUE / 2;
  expect(getRecordingStoragePolicy(bitrate, bitrate)).toBeNull();
});

it("blocks preflight when persistence is denied", async () => {
  await expect(
    runRecordingPreflight(
      {
        ...dependencies({ persist: false, persisted: false }),
      },
      validPolicy
    )
  ).resolves.toEqual({ state: "blocked" });
});

it("blocks preflight when storage is absent", async () => {
  await expect(
    runRecordingPreflight(dependencies({ storage: null }), validPolicy)
  ).resolves.toEqual({ state: "blocked" });
});

it("blocks preflight when the policy threshold overflows", async () => {
  const malformedPolicy = {
    ...validPolicy,
    recoveryTargetBytes: Number.MAX_VALUE,
    safetyMarginBytes: Number.MAX_VALUE,
  };
  await expect(
    runRecordingPreflight(dependencies(), malformedPolicy)
  ).resolves.toEqual({ state: "blocked" });
});

it("blocks preflight with a null policy", async () => {
  await expect(runRecordingPreflight(dependencies(), null)).resolves.toEqual({
    state: "blocked",
  });
});

it("blocks preflight when the probe rejects", async () => {
  await expect(
    runRecordingPreflight(
      dependencies({
        probe: () => Promise.reject(new Error("probe failed")),
      }),
      validPolicy
    )
  ).resolves.toEqual({ state: "blocked" });
});

it.each([
  { quota: Number.NaN, usage: 10 },
  { quota: 1_000_000_000, usage: Number.POSITIVE_INFINITY },
  { quota: undefined, usage: 10 },
  { quota: 1_000_000_000, usage: undefined },
  { quota: -1, usage: 0 },
  { quota: 1_000_000_000, usage: -1 },
])("blocks preflight when quota or usage is invalid", async (estimate) => {
  await expect(
    runRecordingPreflight(dependencies({ estimate }), validPolicy)
  ).resolves.toEqual({ state: "blocked" });
});

it("fails closed when usage exceeds quota", async () => {
  const result = await runRecordingPreflight(
    {
      probe: () => Promise.resolve(),
      storage: storage({ quota: 10, usage: 11 }),
    },
    validPolicy
  );
  expect(result.state).toBe("blocked");
});

it("requires free bytes strictly above the policy requirement", async () => {
  await expect(
    runRecordingPreflight(
      dependencies({
        estimate: {
          quota:
            validPolicy.recoveryTargetBytes + validPolicy.safetyMarginBytes,
          usage: 0,
        },
      }),
      validPolicy
    )
  ).resolves.toEqual({ state: "blocked" });
  await expect(
    runRecordingPreflight(
      dependencies({
        estimate: {
          quota:
            validPolicy.recoveryTargetBytes + validPolicy.safetyMarginBytes + 1,
          usage: 0,
        },
      }),
      validPolicy
    )
  ).resolves.toEqual({ policy: validPolicy, state: "ready" });
});

it("rejects invalid capacity input", () => {
  expect(
    wouldBreachRecordingCapacity(Number.NaN, 100_000_000, validPolicy)
  ).toBe(true);
  expect(wouldBreachRecordingCapacity(0, Number.NaN, validPolicy)).toBe(true);
  expect(wouldBreachRecordingCapacity(0, 100_000_000, null)).toBe(true);
  expect(
    wouldBreachRecordingCapacity(0, 100_000_000, {
      ...validPolicy,
      predictedPartBytes: Number.POSITIVE_INFINITY,
    })
  ).toBe(true);
  expect(
    wouldBreachRecordingCapacity(0, 100_000_000, {
      ...validPolicy,
      recoveryTargetBytes: Number.MAX_VALUE,
      safetyMarginBytes: Number.MAX_VALUE,
    })
  ).toBe(true);
});

it("stops before pending bytes exceed the recovery target", () => {
  const reserved =
    validPolicy.predictedPartBytes * 2 + validPolicy.safetyMarginBytes;
  expect(
    wouldBreachRecordingCapacity(
      validPolicy.recoveryTargetBytes - reserved + 1,
      1_000_000_000,
      validPolicy
    )
  ).toBe(true);
  expect(
    wouldBreachRecordingCapacity(
      validPolicy.recoveryTargetBytes - reserved,
      1_000_000_000,
      validPolicy
    )
  ).toBe(false);
});

it("stops when remaining free space cannot hold reserved parts", () => {
  const reserved = validPolicy.predictedPartBytes * 2;
  expect(
    wouldBreachRecordingCapacity(
      0,
      reserved + validPolicy.safetyMarginBytes,
      validPolicy
    )
  ).toBe(true);
  expect(
    wouldBreachRecordingCapacity(
      0,
      reserved + validPolicy.safetyMarginBytes + 1,
      validPolicy
    )
  ).toBe(false);
});
