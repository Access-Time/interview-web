export interface RecordingStoragePolicy {
  predictedPartBytes: number;
  recoveryTargetBytes: number;
  safetyMarginBytes: number;
}

export type RecordingPreflightResult =
  | { policy: RecordingStoragePolicy; state: "ready" }
  | { state: "blocked" };

const RECORDING_TIMESLICE_MS = 5000;
const RECOVERY_TARGET_SECONDS = 30 * 60;
const RECOVERY_SAFETY_MARGIN = 0.25;

const isFinitePositive = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value > 0;

const isFiniteNonNegative = (value: unknown): value is number =>
  typeof value === "number" && Number.isFinite(value) && value >= 0;

export const getRecordingStoragePolicy = (
  audioBitsPerSecond: number,
  videoBitsPerSecond: number
): RecordingStoragePolicy | null => {
  if (
    !(
      isFinitePositive(audioBitsPerSecond) &&
      isFinitePositive(videoBitsPerSecond)
    )
  ) {
    return null;
  }
  const bitrateBitsPerSecond = audioBitsPerSecond + videoBitsPerSecond;
  if (!isFinitePositive(bitrateBitsPerSecond)) {
    return null;
  }
  const recoveryTargetBytes = Math.ceil(
    (bitrateBitsPerSecond / 8) * RECOVERY_TARGET_SECONDS
  );
  const safetyMarginBytes = Math.ceil(
    recoveryTargetBytes * RECOVERY_SAFETY_MARGIN
  );
  const predictedPartBytes = Math.ceil(
    (bitrateBitsPerSecond / 8) * (RECORDING_TIMESLICE_MS / 1000)
  );
  if (
    !(
      isFinitePositive(predictedPartBytes) &&
      isFinitePositive(recoveryTargetBytes) &&
      isFiniteNonNegative(safetyMarginBytes)
    )
  ) {
    return null;
  }
  return { predictedPartBytes, recoveryTargetBytes, safetyMarginBytes };
};

interface RecordingStoragePreflightDependencies {
  probe: () => Promise<void>;
  storage: {
    estimate: () => Promise<{ quota?: number; usage?: number }>;
    persist: () => Promise<boolean>;
    persisted: () => Promise<boolean>;
  } | null;
}

export const runRecordingPreflight = async (
  dependencies: RecordingStoragePreflightDependencies,
  policy: RecordingStoragePolicy | null
): Promise<RecordingPreflightResult> => {
  if (!(policy && dependencies.storage)) {
    return { state: "blocked" };
  }
  try {
    const persistent = await dependencies.storage.persisted();
    if (!(persistent || (await dependencies.storage.persist()))) {
      return { state: "blocked" };
    }
    const { quota, usage } = await dependencies.storage.estimate();
    if (
      !(isFiniteNonNegative(quota) && isFiniteNonNegative(usage)) ||
      usage > quota
    ) {
      return { state: "blocked" };
    }
    const freeBytes = quota - usage;
    await dependencies.probe();
    return freeBytes > policy.recoveryTargetBytes + policy.safetyMarginBytes
      ? { policy, state: "ready" }
      : { state: "blocked" };
  } catch {
    return { state: "blocked" };
  }
};

export const wouldBreachRecordingCapacity = (
  persistedBytes: unknown,
  freeBytes: unknown,
  policy: RecordingStoragePolicy | null
): boolean => {
  if (
    !(
      isFiniteNonNegative(persistedBytes) &&
      isFiniteNonNegative(freeBytes) &&
      policy
    )
  ) {
    return true;
  }
  const { predictedPartBytes, recoveryTargetBytes, safetyMarginBytes } = policy;
  if (
    !(
      isFinitePositive(predictedPartBytes) &&
      isFinitePositive(recoveryTargetBytes) &&
      isFiniteNonNegative(safetyMarginBytes)
    )
  ) {
    return true;
  }
  const reserved = predictedPartBytes * 2 + safetyMarginBytes;
  return (
    !isFinitePositive(reserved) ||
    persistedBytes + reserved > recoveryTargetBytes ||
    freeBytes <= reserved
  );
};
