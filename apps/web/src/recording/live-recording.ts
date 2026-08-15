import { useEffect, useRef, useState } from "react";
import {
  getRecordingStoragePolicy,
  type RecordingStoragePolicy,
  runRecordingPreflight,
  wouldBreachRecordingCapacity,
} from "./recording-admission";
import type {
  AppendSegmentMutate,
  CreateRecordingMutate,
  FinalizeRecordingMutate,
} from "./recording-mutate";

export type RecordingSaveState = "healthy" | "offline" | "error";
export type RecordingFinalizationState =
  | "queued"
  | "finalizing"
  | "ready"
  | "failed";
export interface RecordingFinalizationStatus {
  status: RecordingFinalizationState;
}
export interface RecordingFinalizationResult {
  error: string | null;
  state: RecordingFinalizationState;
}

export function normalizeFinalizationStatus(
  result: unknown
): RecordingFinalizationState | null {
  if (typeof result !== "object" || result === null || !("status" in result)) {
    return null;
  }
  const status = String(result.status);
  return ["queued", "finalizing", "ready", "failed"].includes(status)
    ? (status as RecordingFinalizationState)
    : null;
}

export interface UseLiveRecordingResult {
  canResetRecoveredRecording: boolean;
  captureEnded: boolean;
  error: string | null;
  finalization: RecordingFinalizationResult | null;
  hasIncompleteRecordingFinalization: boolean;
  hasUnsentRecordingMedia: boolean;
  initialize: () => Promise<void>;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  recordingPreflightState: RecordingPreflightState;
  recordingStopReason: RecordingStopReason;
  recovered: boolean;
  resetRecoveredRecording: () => Promise<void>;
  retryFinalization: () => Promise<void>;
  retryRecordingPreflight: () => Promise<void>;
  saveState: RecordingSaveState;
  start: () => Promise<void>;
  stop: () => Promise<void>;
  stream: MediaStream | null;
}

export interface RecordingPart {
  blob: Blob;
  mediaType: string;
  segmentId: string;
  sequence: number;
  sessionId: string;
}

export interface RecordingSegment {
  partCount: number;
  segmentId: string;
}

export interface RecordingSession {
  recorderMimeType: string | null;
  requestedMimeType: string | null;
  segments: RecordingSegment[];
  sessionId: string;
  status: "recording" | "sealed";
}

export function recordingIntentMetadata(
  stored: RecordingSession | null | undefined,
  current: { requestedMimeType: string | null; recorderMimeType: string | null }
) {
  return stored?.segments.at(-1)?.partCount === 0
    ? {
        recorderMimeType: stored.recorderMimeType,
        requestedMimeType: stored.requestedMimeType,
      }
    : current;
}

export function recordingRemoteAction(
  previous: RecordingSession | null | undefined,
  resumeTail: boolean
): "append" | "create" {
  return !previous || (resumeTail && previous.segments.length === 1)
    ? "create"
    : "append";
}

export interface RecordingManifestView {
  segments: Array<{
    id: string;
    parts: Array<{ checksum: string; sequence: number }>;
  }>;
  sessionId: string;
}

export type RecordingManifestLookup =
  | { kind: "found"; manifest: RecordingManifestView }
  | { kind: "missing" };

export type RecordingJourneyOutcome =
  | "none"
  | "automatic-retry"
  | "manual-retry"
  | "terminal-restart"
  | "missing-recovery";

export type RecordingPreflightState = "idle" | "checking" | "ready" | "blocked";
export type RecordingStopReason =
  | "candidate"
  | "capacity"
  | "save-failure"
  | null;

interface RecordingJourneyState {
  canResetRecoveredRecording: boolean;
  captureEnded: boolean;
  error: string | null;
  finalization: RecordingFinalizationResult | null;
  hasIncompleteRecordingFinalization: boolean;
  hasUnsentRecordingMedia: boolean;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  recordingPreflightState: RecordingPreflightState;
  recordingStopReason: RecordingStopReason;
  recovered: boolean;
  saveState: RecordingSaveState;
  stream: MediaStream | null;
}

const isPendingFinalizationState = (state: RecordingFinalizationState) =>
  state === "queued" || state === "finalizing";

interface PartStore {
  delete: (part: RecordingPart) => Promise<void>;
  put: (part: RecordingPart) => Promise<void>;
}

export interface RecordingRecoveryStore extends PartStore {
  deleteSession?: (sessionId: string) => Promise<void>;
  discardSession: (sessionId: string) => Promise<void>;
  getSession?: (sessionId: string) => Promise<RecordingSession | undefined>;
  listParts?: () => Promise<RecordingPart[]>;
  listSessions?: () => Promise<RecordingSession[]>;
  putPartAndSession?: (
    part: RecordingPart,
    session: RecordingSession
  ) => Promise<void>;
  putSession?: (session: RecordingSession) => Promise<void>;
}

async function recordingBlobChecksum(blob: Blob): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

type RecordingFailure = Error & {
  readonly recordingFailure: "fatal" | "retryable";
};

function markRecordingFailure(
  cause: unknown,
  kind: RecordingFailure["recordingFailure"]
): RecordingFailure {
  const error = new Error(
    cause instanceof Error ? cause.message : String(cause)
  );
  Object.defineProperty(error, "recordingFailure", { value: kind });
  return error as RecordingFailure;
}

export function isRetryableRecordingFailure(
  error: unknown
): error is RecordingFailure {
  return (
    error instanceof Error &&
    (error as Partial<RecordingFailure>).recordingFailure === "retryable"
  );
}

function isFatalRecordingFailure(error: unknown): error is RecordingFailure {
  return (
    error instanceof Error &&
    (error as Partial<RecordingFailure>).recordingFailure === "fatal"
  );
}

const MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  "video/webm",
];
const PREFLIGHT_PROBE_KEY = "__recording_preflight_probe__";

const ignorePromise = (promise: Promise<unknown>) => {
  promise.catch(() => undefined);
};

function browserStore(): {
  recoveryStore: RecordingRecoveryStore;
  probe: () => Promise<void>;
} {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("live-recording-outbox", 2);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains("parts")) {
          db.createObjectStore("parts", { keyPath: "id" });
        }
        if (!db.objectStoreNames.contains("sessions")) {
          db.createObjectStore("sessions", { keyPath: "sessionId" });
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () =>
        reject(request.error ?? new Error("Unable to open recording storage"));
    });
    return database;
  };
  const key = (part: RecordingPart) =>
    `${part.sessionId}:${part.segmentId}:${part.sequence}`;
  const transaction = (
    mode: IDBTransactionMode,
    action: (parts: IDBObjectStore, sessions: IDBObjectStore) => void
  ) =>
    open().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction(["parts", "sessions"], mode);
          action(tx.objectStore("parts"), tx.objectStore("sessions"));
          tx.oncomplete = () => resolve();
          tx.onerror = () =>
            reject(
              tx.error ?? new Error("Recording storage transaction failed")
            );
          tx.onabort = () =>
            reject(
              tx.error ?? new Error("Recording storage transaction aborted")
            );
        })
    );
  const recoveryStore: RecordingRecoveryStore = {
    delete: (part) =>
      transaction("readwrite", (store) => store.delete(key(part))),
    deleteSession: (sessionId) =>
      transaction("readwrite", (_, store) => store.delete(sessionId)),
    discardSession: (sessionId) =>
      open().then(
        (db) =>
          new Promise<void>((resolve, reject) => {
            const tx = db.transaction(["parts", "sessions"], "readwrite");
            const parts = tx.objectStore("parts");
            const request = parts.getAll();
            request.onsuccess = () => {
              for (const item of request.result as Array<
                RecordingPart & { id: string }
              >) {
                if (item.sessionId === sessionId) {
                  parts.delete(item.id);
                }
              }
              tx.objectStore("sessions").delete(sessionId);
            };
            request.onerror = () => reject(request.error);
            tx.oncomplete = () => resolve();
            tx.onerror = () =>
              reject(
                tx.error ?? new Error("Recording storage transaction failed")
              );
            tx.onabort = () =>
              reject(
                tx.error ?? new Error("Recording storage transaction aborted")
              );
          })
      ),
    listParts: () =>
      open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const request = db
              .transaction("parts")
              .objectStore("parts")
              .getAll();
            request.onsuccess = () =>
              resolve(request.result as RecordingPart[]);
            request.onerror = () => reject(request.error);
          })
      ),
    listSessions: () =>
      open().then(
        (db) =>
          new Promise((resolve, reject) => {
            const request = db
              .transaction("sessions")
              .objectStore("sessions")
              .getAll();
            request.onsuccess = () =>
              resolve(request.result as RecordingSession[]);
            request.onerror = () => reject(request.error);
          })
      ),
    put: (part) =>
      transaction("readwrite", (store) =>
        store.put({ ...part, id: key(part) })
      ),
    putPartAndSession: (part, session) =>
      transaction("readwrite", (parts, sessions) => {
        parts.put({ ...part, id: key(part) });
        sessions.put(session);
      }),
    putSession: (session) =>
      transaction("readwrite", (_, store) => store.put(session)),
  };
  const probe = () =>
    transaction("readwrite", (store) => {
      store.put({ id: PREFLIGHT_PROBE_KEY });
      store.delete(PREFLIGHT_PROBE_KEY);
    });
  return { probe, recoveryStore };
}

export function createLiveRecordingOutbox(
  store: RecordingRecoveryStore = browserStore().recoveryStore,
  request: typeof fetch = fetch,
  onError?: (error: unknown) => void,
  onChange?: () => void
) {
  const pending = new Map<string, RecordingPart>();
  let persistedBytes = 0;
  let flushPromise: Promise<void> | undefined;
  let disposed = false;
  let online = true;
  let saveState: RecordingSaveState = "healthy";

  const getPartKey = (part: RecordingPart) =>
    `${part.sessionId}:${part.segmentId}:${part.sequence}`;
  const rememberPendingPart = (part: RecordingPart) => {
    const partKey = getPartKey(part);
    if (!pending.has(partKey)) {
      persistedBytes += part.blob.size;
    }
    pending.set(partKey, part);
  };
  const acknowledgePendingPart = async (part: RecordingPart) => {
    await store.delete(part);
    const partKey = getPartKey(part);
    if (pending.delete(partKey)) {
      persistedBytes -= part.blob.size;
    }
    saveState = "healthy";
    onChange?.();
  };
  const deleteSession = async (sessionId: string) => {
    await store.deleteSession?.(sessionId);
    for (const [key, part] of pending) {
      if (part.sessionId === sessionId) {
        pending.delete(key);
        persistedBytes -= part.blob.size;
      }
    }
    onChange?.();
  };
  const clearPendingSession = (sessionId: string) => {
    for (const [key, part] of pending) {
      if (part.sessionId === sessionId) {
        pending.delete(key);
        persistedBytes -= part.blob.size;
      }
    }
    onChange?.();
  };
  const send = async (part: RecordingPart): Promise<void> => {
    let response: Response;
    try {
      const checksum = await recordingBlobChecksum(part.blob);
      response = await request(
        `/api/recordings/${encodeURIComponent(part.sessionId)}/segments/${encodeURIComponent(part.segmentId)}/parts/${part.sequence}`,
        {
          body: part.blob,
          headers: {
            "Content-Type": part.mediaType || "application/octet-stream",
            "X-Content-SHA256": checksum,
          },
          method: "PUT",
        }
      );
    } catch (error) {
      throw markRecordingFailure(error, "retryable");
    }
    if (!response.ok) {
      const temporary =
        [408, 429].includes(response.status) || response.status >= 500;
      throw markRecordingFailure(
        `Recording part upload failed (${response.status})`,
        temporary ? "retryable" : "fatal"
      );
    }
    try {
      await acknowledgePendingPart(part);
    } catch (error) {
      throw markRecordingFailure(error, "fatal");
    }
  };
  const flush = (): Promise<void> => {
    if (flushPromise) {
      return flushPromise;
    }
    if (disposed || !online) {
      return Promise.resolve();
    }

    flushPromise = (async () => {
      while (online && !disposed) {
        const [nextPart] = [...pending.values()].sort(
          (left, right) =>
            left.sessionId.localeCompare(right.sessionId) ||
            left.segmentId.localeCompare(right.segmentId) ||
            left.sequence - right.sequence
        );
        if (!nextPart) {
          return;
        }
        try {
          // biome-ignore lint/performance/noAwaitInLoops: uploads intentionally remain sequential.
          await send(nextPart);
        } catch (error) {
          saveState = online ? "error" : "offline";
          onError?.(error);
          onChange?.();
          return;
        }
      }
    })().finally(() => {
      flushPromise = undefined;
    });

    return flushPromise;
  };
  const hydrate = async () => {
    const [parts] = await Promise.all([
      store.listParts?.() ?? Promise.resolve([]),
    ]);
    pending.clear();
    persistedBytes = 0;
    for (const item of parts) {
      rememberPendingPart(item);
    }
    onChange?.();
  };
  return {
    async deleteSession(sessionId: string) {
      await deleteSession(sessionId);
    },
    async discardSession(sessionId: string) {
      await store.discardSession(sessionId);
      clearPendingSession(sessionId);
    },
    dispose() {
      disposed = true;
    },
    async drain() {
      await flush();
      if (pending.size) {
        throw markRecordingFailure(
          "Recording uploads are still pending",
          "retryable"
        );
      }
    },
    getPersistedBytes: () => persistedBytes,
    getSessions() {
      return store.listSessions?.() ?? [];
    },
    hasUnsentMedia: () => pending.size > 0,
    hydrate,
    async persistPart(part: RecordingPart) {
      try {
        await store.put(part);
      } catch (error) {
        const failure = markRecordingFailure(error, "fatal");
        saveState = "error";
        onError?.(failure);
        onChange?.();
        throw failure;
      }
      rememberPendingPart(part);
      saveState = "healthy";
      onChange?.();
      ignorePromise(flush());
    },
    async recover(lookup?: RecordingManifestLookup) {
      await flush();
      const sessions = await (store.listSessions?.() ?? Promise.resolve([]));
      const session =
        sessions.find((item) => item.status === "recording") ?? null;
      return {
        missing: lookup?.kind === "missing",
        recovered: Boolean(session),
        session,
      };
    },
    async savePartAndSession(part: RecordingPart, session: RecordingSession) {
      try {
        if (store.putPartAndSession) {
          await store.putPartAndSession(part, session);
        } else {
          await store.put(part);
          await store.putSession?.(session);
        }
      } catch (error) {
        const failure = markRecordingFailure(error, "fatal");
        saveState = "error";
        onError?.(failure);
        onChange?.();
        throw failure;
      }
      rememberPendingPart(part);
      saveState = "healthy";
      onChange?.();
      ignorePromise(flush());
    },
    async saveSession(session: RecordingSession) {
      await store.putSession?.(session);
    },
    get saveState(): RecordingSaveState {
      return online ? saveState : "offline";
    },
    async setOnline(
      value: boolean,
      options?: { flush?: boolean; reconnect?: boolean }
    ) {
      online = value;
      onChange?.();
      if (value && options?.flush !== false) {
        await flush();
      }
      onChange?.();
    },
  };
}

export interface UseLiveRecordingOptions {
  appendSegment: AppendSegmentMutate;
  createSession: CreateRecordingMutate;
  finalizeSession: FinalizeRecordingMutate;
  getManifest?: (input: {
    sessionId: string;
  }) => Promise<RecordingManifestLookup>;
  manifestLookup?: RecordingManifestLookup;
  onRequestManifest?: (sessionId: string | null) => void;
  onRequestStatus?: (sessionId: string | null) => void;
  status?: RecordingFinalizationState | null;
}

type LegacyLiveRecordingOptions = Omit<
  UseLiveRecordingOptions,
  "getManifest"
> & {
  getManifest?: (input: {
    sessionId: string;
  }) => Promise<RecordingManifestView | null>;
};

export function useLiveRecording(
  options: UseLiveRecordingOptions | LegacyLiveRecordingOptions
): UseLiveRecordingResult {
  const outbox = useRef<ReturnType<typeof createLiveRecordingOutbox> | null>(
    null
  );
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const preparedRecorderRef = useRef<MediaRecorder | null>(null);
  const recordingPolicyRef = useRef<RecordingStoragePolicy | null>(null);
  const recoveryStoreRef = useRef<RecordingRecoveryStore | null>(null);
  const probeRef = useRef<(() => Promise<void>) | null>(null);
  const sequence = useRef(0);
  const processing = useRef(new Set<Promise<void>>());
  const ids = useRef<{ sessionId: string; segmentId: string } | null>(null);
  const session = useRef<RecordingSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const persistingTerminalPart = useRef(false);
  const shouldSafetyStop = useRef(false);
  const terminalDataRef = useRef<{
    awaiting: boolean;
    promise: Promise<void>;
    resolve: () => void;
  } | null>(null);
  const lifecycle = useRef<boolean | undefined>(undefined);
  const [journey, setJourney] = useState<RecordingJourneyState>({
    canResetRecoveredRecording: false,
    captureEnded: false,
    error: null,
    finalization: null,
    hasIncompleteRecordingFinalization: false,
    hasUnsentRecordingMedia: false,
    isReady: false,
    isRecording: false,
    journeyOutcome: "none",
    recordingPreflightState: "idle",
    recordingStopReason: null,
    recovered: false,
    saveState: "healthy",
    stream: null,
  });
  const patchJourney = (patch: Partial<RecordingJourneyState>) =>
    setJourney((current) => ({ ...current, ...patch }));
  const {
    stream,
    isReady,
    isRecording,
    captureEnded,
    error,
    recovered,
    canResetRecoveredRecording,
    finalization,
    recordingPreflightState,
    recordingStopReason,
    hasIncompleteRecordingFinalization,
    hasUnsentRecordingMedia,
    saveState,
    journeyOutcome,
  } = journey;
  const setStream = (next: MediaStream | null) =>
    patchJourney({ stream: next });
  const setReady = (next: boolean) => patchJourney({ isReady: next });
  const setRecording = (next: boolean) => patchJourney({ isRecording: next });
  const setCaptureEnded = (next: boolean) =>
    patchJourney({ captureEnded: next });
  const setError = (next: string | null) => patchJourney({ error: next });
  const setRecovered = (next: boolean) => patchJourney({ recovered: next });
  const setJourneyOutcome = (next: RecordingJourneyOutcome) =>
    patchJourney({ journeyOutcome: next });
  const setCanResetRecoveredRecording = (next: boolean) =>
    patchJourney({ canResetRecoveredRecording: next });
  const setRecordingPreflightState = (next: RecordingPreflightState) =>
    patchJourney({ recordingPreflightState: next });
  const setRecordingStopReason = (next: RecordingStopReason) =>
    patchJourney({ recordingStopReason: next });
  const setIncompleteFinalization = (next: boolean) =>
    patchJourney({ hasIncompleteRecordingFinalization: next });
  const finalizationInput = useRef<{
    sessionId: string;
    segments: Array<{ segmentId: string; partCount: number }>;
  } | null>(null);
  const finalizationAttempted = useRef(false);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const pollGeneration = useRef(0);
  const recoveryGeneration = useRef(0);
  const recoveryPromise = useRef<Promise<void> | null>(null);
  const captureEndingRef = useRef<Promise<void> | null>(null);
  const captureCauseRef = useRef<unknown>(undefined);
  const finalizationInFlight = useRef(false);
  const sealedPumpLock = useRef(false);
  const sealedPlans = useRef<
    Array<{
      sessionId: string;
      segments: Array<{ segmentId: string; partCount: number }>;
    }>
  >([]);
  const submitSealedRef = useRef<(() => Promise<void>) | null>(null);
  const applyRecoveryRef = useRef<
    ((lookup?: RecordingManifestLookup) => Promise<unknown>) | null
  >(null);

  const cancelFinalizationPolling = () => {
    requestStatus(null);
  };

  const setFinalizationState = (value: RecordingFinalizationResult | null) => {
    patchJourney({ finalization: value });
  };
  const revokeRecoveryReset = () => {
    setJourneyOutcome("none");
    setCanResetRecoveredRecording(false);
  };

  const completeReadyFinalization = async (input: {
    sessionId: string;
    segments: Array<{ segmentId: string; partCount: number }>;
  }) => {
    await outbox.current?.deleteSession(input.sessionId);
    sealedPlans.current = sealedPlans.current.filter(
      (plan) => plan.sessionId !== input.sessionId
    );
    if (finalizationInput.current?.sessionId === input.sessionId) {
      finalizationInput.current = null;
    }
    setFinalizationState({ error: null, state: "ready" });
    setIncompleteFinalization(false);
    if (
      !sealedPlans.current.length &&
      session.current?.status === "recording"
    ) {
      setFinalizationState(null);
    }
    ignorePromise(submitSealedRef.current?.() ?? Promise.resolve());
  };

  const requestStatus = (sessionId: string | null) => {
    options.onRequestStatus?.(sessionId);
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: lifecycle effect intentionally runs once; mutable refs carry runtime callbacks.
  useEffect(() => {
    lifecycle.current = false;
    const isDisposed = () => lifecycle.current === true;
    const browserStorage = browserStore();
    recoveryStoreRef.current = browserStorage.recoveryStore;
    probeRef.current = browserStorage.probe;
    const box = createLiveRecordingOutbox(
      browserStorage.recoveryStore,
      undefined,
      (cause) => {
        if (isDisposed()) {
          return;
        }
        if (isRetryableRecordingFailure(cause)) {
          return;
        }
        captureCauseRef.current = cause;
        setError(cause instanceof Error ? cause.message : String(cause));
        setJourneyOutcome("terminal-restart");
        ignorePromise(endCapture(cause));
      },
      () => {
        patchJourney({
          hasUnsentRecordingMedia: box.hasUnsentMedia(),
          saveState: box.saveState,
        });
      }
    );
    outbox.current = box;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: sealed plans are intentionally drained and submitted in order.
    const submitSealed = async () => {
      // biome-ignore lint/suspicious/noUnnecessaryConditions: this ref is a runtime serialization lock.
      if (sealedPumpLock.current || finalizationInFlight.current) {
        return;
      }
      sealedPumpLock.current = true;
      try {
        while (sealedPlans.current.length && !finalizationInFlight.current) {
          const [plan] = sealedPlans.current;
          finalizationInput.current = plan;
          setFinalizationState({ error: null, state: "queued" });
          try {
            // biome-ignore lint/performance/noAwaitInLoops: each plan must complete before the next is submitted.
            await box.drain();
            finalizationAttempted.current = true;
            finalizationInFlight.current = true;
            finalize(plan);
            return;
          } catch (cause) {
            finalizationInFlight.current = false;
            if (
              box.saveState !== "offline" &&
              !isRetryableRecordingFailure(cause)
            ) {
              setError(cause instanceof Error ? cause.message : String(cause));
            }
            return;
          }
        }
      } finally {
        sealedPumpLock.current = false;
      }
    };
    submitSealedRef.current = submitSealed;
    recoveryGeneration.current += 1;
    const generation = recoveryGeneration.current;
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: recovery coordinates durable state and retry state.
    const applyRecovery = async (_lookup?: RecordingManifestLookup) => {
      const recovery = await box.recover(_lookup);
      if (generation !== recoveryGeneration.current || isDisposed()) {
        return recovery;
      }
      if (recovery.recovered) {
        setRecovered(true);
      }
      if (recovery.session) {
        session.current = recovery.session;
        const lastSegment = recovery.session.segments.at(-1);
        if (lastSegment) {
          ids.current = {
            segmentId: lastSegment.segmentId,
            sessionId: recovery.session.sessionId,
          };
        }
      }
      if (recovery.missing) {
        setJourneyOutcome("missing-recovery");
        setCanResetRecoveredRecording(Boolean(recovery.session && ids.current));
      } else {
        revokeRecoveryReset();
      }
      return recovery;
    };
    applyRecoveryRef.current = applyRecovery;
    const enqueueRecovery = (task: () => Promise<void>) => {
      const next = (recoveryPromise.current ?? Promise.resolve())
        .catch(() => undefined)
        .then(async () => {
          if (generation !== recoveryGeneration.current || isDisposed()) {
            return;
          }
          await task();
        });
      recoveryPromise.current = next;
      return next;
    };
    const recoverFromStore = async () => {
      const sessions = await box.getSessions();
      const stored = sessions
        .filter((item) => item.status === "recording")
        .sort((left, right) => left.sessionId.localeCompare(right.sessionId))
        .at(0);
      if (stored && navigator.onLine) {
        if (options.getManifest) {
          const result = await options.getManifest({
            sessionId: stored.sessionId,
          });
          if (result === null) {
            throw new Error("Recording manifest lookup unavailable");
          }
          await applyRecovery(
            "kind" in result ? result : { kind: "found", manifest: result }
          );
          return;
        }
        options.onRequestManifest?.(stored.sessionId);
        return;
      }
      await applyRecovery();
    };
    const online = () => {
      ignorePromise(
        enqueueRecovery(async () => {
          await box.setOnline(true, { flush: false, reconnect: true });
          await recoverFromStore();
          await submitSealed();
        })
      );
    };
    const offline = () => box.setOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    box.setOnline(navigator.onLine, { flush: false });
    ignorePromise(
      enqueueRecovery(async () => {
        await box.hydrate();
        if (generation !== recoveryGeneration.current || isDisposed()) {
          return;
        }
        await recoverFromStore();
        if (generation !== recoveryGeneration.current || isDisposed()) {
          return;
        }
        const sessions = await box.getSessions();
        sealedPlans.current = sessions
          .filter((item) => item.status === "sealed")
          .map((item) => ({
            segments: item.segments,
            sessionId: item.sessionId,
          }));
        if (sealedPlans.current.length) {
          await submitSealed();
        }
      })
    );
    return () => {
      lifecycle.current = true;
      recoveryGeneration.current += 1;
      pollGeneration.current += 1;
      // biome-ignore lint/suspicious/noUnnecessaryConditions: timer refs are populated at runtime.
      if (pollTimer.current) {
        clearTimeout(pollTimer.current);
      }
      pollTimer.current = undefined;
      window.removeEventListener("online", online);
      window.removeEventListener("offline", offline);
      outbox.current?.dispose();
      if (recorder.current?.state !== "inactive") {
        recorder.current?.stop();
      }
      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
      streamRef.current = null;
    };
  }, []);

  useEffect(() => {
    if (options.getManifest || !options.manifestLookup) {
      return;
    }
    ignorePromise(
      Promise.resolve(applyRecoveryRef.current?.(options.manifestLookup))
    );
  }, [options.getManifest, options.manifestLookup]);

  const isRemoteReady = options.status === "ready";
  // biome-ignore lint/correctness/useExhaustiveDependencies: IndexedDB cleanup runs when remote status becomes ready; refs hold the latest session plan.
  useEffect(() => {
    if (!isRemoteReady) {
      return;
    }
    const input = finalizationInput.current;
    if (input === null) {
      return;
    }
    ignorePromise(completeReadyFinalization(input));
    requestStatus(null);
  }, [isRemoteReady]);

  const createRecorder = (media: MediaStream) => {
    const requested =
      MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
    return requested
      ? new MediaRecorder(media, { mimeType: requested })
      : new MediaRecorder(media);
  };

  const prepareRecording = async () => {
    const media = streamRef.current;
    const recoveryStore = recoveryStoreRef.current;
    const probe = probeRef.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: refs are populated after initialize.
    if (!(media && recoveryStore && probe)) {
      setRecordingPreflightState("blocked");
      return;
    }
    setRecordingPreflightState("checking");
    const nextRecorder = createRecorder(media);
    const policy = getRecordingStoragePolicy(
      nextRecorder.audioBitsPerSecond,
      nextRecorder.videoBitsPerSecond
    );
    const result = await runRecordingPreflight(
      {
        probe,
        storage: navigator.storage ?? null,
      },
      policy
    );
    if (lifecycle.current === true) {
      return;
    }
    if (result.state === "blocked") {
      preparedRecorderRef.current = null;
      recordingPolicyRef.current = null;
      setRecordingPreflightState("blocked");
      return;
    }
    preparedRecorderRef.current = nextRecorder;
    recordingPolicyRef.current = result.policy;
    setRecordingPreflightState("ready");
  };

  const initialize = async () => {
    try {
      const acquired = await navigator.mediaDevices.getUserMedia({
        audio: true,
        video: { facingMode: "user" },
      });
      if (lifecycle.current === true) {
        for (const track of acquired.getTracks()) {
          track.stop();
        }
        return;
      }
      streamRef.current = acquired;
      setStream(acquired);
      setReady(true);
      setError(null);
      await prepareRecording();
    } catch (cause) {
      if (lifecycle.current === true) {
        return;
      }
      setError(
        `Unable to access camera and microphone: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  };

  const retryRecordingPreflight = async () => {
    // biome-ignore lint/suspicious/noUnnecessaryConditions: retry is a no-op before a stream exists.
    if (!streamRef.current) {
      return;
    }
    await prepareRecording();
  };
  // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: start coordinates the persisted intent, remote intent, and recorder lifecycle.
  const start = async () => {
    revokeRecoveryReset();
    await recoveryPromise.current;
    if (sealedPlans.current.length) {
      throw new Error("The previous recording is still being finalized");
    }
    if (!stream) {
      throw new Error("Recording is not initialized");
    }
    if (
      recordingPreflightState !== "ready" ||
      !preparedRecorderRef.current ||
      !recordingPolicyRef.current
    ) {
      return;
    }
    const requested =
      MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
    const previous = session.current;
    if (previous?.status === "sealed") {
      throw new Error("The previous recording is still being finalized");
    }
    const resumeTail = previous?.segments.at(-1)?.partCount === 0;
    if (!resumeTail && (previous?.segments.length ?? 0) >= 5) {
      throw new Error("A recording cannot contain more than five segments");
    }
    const sessionId = previous?.sessionId ?? crypto.randomUUID();
    const segmentId = resumeTail
      ? (previous.segments.at(-1)?.segmentId ?? crypto.randomUUID())
      : crypto.randomUUID();
    const instance = preparedRecorderRef.current;
    cancelFinalizationPolling();
    finalizationAttempted.current = false;
    finalizationInput.current = null;
    shouldSafetyStop.current = false;
    persistingTerminalPart.current = false;
    setRecordingStopReason(null);
    setIncompleteFinalization(false);
    setFinalizationState(null);
    ids.current = { segmentId, sessionId };
    sequence.current = 0;
    recorder.current = instance;
    let resolveTerminalData!: () => void;
    const terminalData = new Promise<void>((resolve) => {
      resolveTerminalData = resolve;
    });
    terminalDataRef.current = {
      awaiting: false,
      promise: terminalData,
      resolve: resolveTerminalData,
    };
    const metadata = {
      recorderMimeType: instance.mimeType || null,
      requestedMimeType: requested,
      segmentId,
      sessionId,
    };
    const intent = recordingIntentMetadata(previous, metadata);
    const nextSession: RecordingSession = {
      recorderMimeType: intent.recorderMimeType,
      requestedMimeType: intent.requestedMimeType,
      segments: resumeTail
        ? previous.segments
        : [...(previous?.segments ?? []), { partCount: 0, segmentId }],
      sessionId,
      status: "recording",
    };
    session.current = nextSession;
    await outbox.current?.saveSession(nextSession);
    const remoteMetadata = { ...metadata, ...intent };
    const beginCapture = () => {
      if (lifecycle.current === true) {
        return;
      }
      instance.ondataavailable = (event) => {
        const isTerminalPart = Boolean(terminalDataRef.current?.awaiting);
        if (isTerminalPart) {
          persistingTerminalPart.current = true;
          terminalDataRef.current?.resolve();
        }
        if (!(event.data.size && ids.current && outbox.current)) {
          return;
        }
        const part = {
          ...ids.current,
          blob: event.data,
          mediaType:
            event.data.type || instance.mimeType || "application/octet-stream",
          sequence: sequence.current,
        };
        sequence.current += 1;
        const currentSession = session.current;
        // biome-ignore lint/suspicious/noUnnecessaryConditions: session is established before MediaRecorder starts.
        if (!currentSession) {
          return;
        }
        const updatedSession = {
          recorderMimeType: currentSession.recorderMimeType,
          requestedMimeType: currentSession.requestedMimeType,
          segments: currentSession.segments.map((segment) =>
            segment.segmentId === part.segmentId
              ? { ...segment, partCount: part.sequence + 1 }
              : segment
          ),
          sessionId: currentSession.sessionId,
          status: currentSession.status,
        };
        session.current = updatedSession;
        const persistPart = async () => {
          try {
            await outbox.current?.savePartAndSession(part, updatedSession);
          } catch (cause) {
            failSave(cause);
            return;
          }
          // biome-ignore lint/suspicious/noUnnecessaryConditions: terminal parts skip a second capacity check.
          if (persistingTerminalPart.current) {
            return;
          }
          const policy = recordingPolicyRef.current;
          // biome-ignore lint/suspicious/noUnnecessaryConditions: start is gated on an admitted policy.
          if (!policy) {
            return;
          }
          await evaluateCapacityStop(policy);
        };
        const work = persistPart();
        processing.current.add(work);
        ignorePromise(
          work.finally(() => {
            processing.current.delete(work);
            // biome-ignore lint/suspicious/noUnnecessaryConditions: capacity is evaluated after each durable part.
            if (shouldSafetyStop.current && !captureEndingRef.current) {
              ignorePromise(endCapture(undefined, "capacity"));
            }
          })
        );
      };
      instance.onerror = (event) => {
        if (lifecycle.current !== true) {
          captureCauseRef.current = event;
          setError("Recording failed while capturing media");
          ignorePromise(endCapture(event));
        }
      };
      instance.onstop = () => {
        if (lifecycle.current !== true) {
          setRecording(false);
        }
      };
      instance.start(5000);
      captureEndingRef.current = null;
      captureCauseRef.current = undefined;
      setCaptureEnded(false);
      if (lifecycle.current === false || lifecycle.current === undefined) {
        setRecording(true);
        setError(null);
      }
    };
    const failStart = (startError: { message: string }) => {
      setError(startError.message);
    };
    if (recordingRemoteAction(previous, resumeTail) === "append") {
      options.appendSegment(remoteMetadata, {
        onError: failStart,
        onSuccess: beginCapture,
      });
      return;
    }
    options.createSession(remoteMetadata, {
      onError: failStart,
      onSuccess: beginCapture,
    });
  };
  const evaluateCapacityStop = async (policy: RecordingStoragePolicy) => {
    try {
      const estimate = await navigator.storage?.estimate();
      const quota = estimate?.quota;
      const usage = estimate?.usage;
      const freeBytes =
        Number.isFinite(quota) && Number.isFinite(usage)
          ? Number(quota) - Number(usage)
          : 0;
      if (
        wouldBreachRecordingCapacity(
          outbox.current?.getPersistedBytes() ?? 0,
          freeBytes,
          policy
        )
      ) {
        shouldSafetyStop.current = true;
      }
    } catch {
      shouldSafetyStop.current = true;
    }
  };

  const failSave = (cause: unknown) => {
    setRecordingStopReason("save-failure");
    captureCauseRef.current = cause;
    setError(cause instanceof Error ? cause.message : String(cause));
    setJourneyOutcome("terminal-restart");
    setCaptureEnded(true);
    setRecording(false);
    for (const track of streamRef.current?.getTracks() ?? []) {
      track.stop();
    }
    streamRef.current = null;
    setStream(null);
    setReady(false);
    const instance = recorder.current;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: save failure can race recorder shutdown.
    if (instance && instance.state !== "inactive") {
      instance.stop();
    }
  };

  const endCapture = (
    cause?: unknown,
    reason: Exclude<RecordingStopReason, null> = "candidate"
  ): Promise<void> => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: capture shutdown serializes media, persistence, and finalization failures.
    captureEndingRef.current ??= (async () => {
      setRecordingStopReason(reason);
      setCaptureEnded(true);
      setRecording(false);

      for (const track of streamRef.current?.getTracks() ?? []) {
        track.stop();
      }
      streamRef.current = null;
      setStream(null);
      setReady(false);

      try {
        const instance = recorder.current;
        const terminalData = terminalDataRef.current;
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the recorder may end before its terminal listener is installed.
        if (terminalData) {
          terminalData.awaiting = true;
        }
        // biome-ignore lint/suspicious/noUnnecessaryConditions: shutdown can race recorder creation.
        if (instance && instance.state !== "inactive") {
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            instance.addEventListener("stop", done, { once: true });
            instance.stop();
          });
        }
        // biome-ignore lint/suspicious/noUnnecessaryConditions: the terminal promise is optional before a valid capture.
        if (terminalData) {
          await terminalData.promise;
        }

        while (processing.current.size) {
          // biome-ignore lint/performance/noAwaitInLoops: capture processing can enqueue during drain.
          await Promise.all(processing.current);
        }

        const currentIds = ids.current;
        const box = outbox.current;
        // biome-ignore lint/suspicious/noUnnecessaryConditions: refs can be empty after an interrupted capture.
        if (!(currentIds && box)) {
          throw new Error(
            "Recording session is unavailable; press Start to retry"
          );
        }
        const plan = {
          segments: session.current?.segments ?? [
            { partCount: sequence.current, segmentId: currentIds.segmentId },
          ],
          sessionId: currentIds.sessionId,
        };
        const currentSession = session.current;
        // biome-ignore lint/suspicious/noUnnecessaryConditions: persistence may fail before a session is established.
        if (!currentSession) {
          throw new Error(
            "Recording session is unavailable; press Start to retry"
          );
        }
        if (plan.segments.some((segment) => segment.partCount === 0)) {
          session.current = { ...currentSession, status: "recording" };
          await box.saveSession(session.current);
          throw new Error(
            "Recording stopped before any media data was captured; press Start to retry"
          );
        }
        session.current = {
          ...currentSession,
          segments: plan.segments,
          status: "sealed",
        };
        await box.saveSession(session.current);
        sealedPlans.current.push(plan);
        finalizationInput.current ??= plan;
        setIncompleteFinalization(true);
        setFinalizationState({ error: null, state: "queued" });
        await submitSealedRef.current?.();

        const finalizationState = finalization?.state;
        if (finalizationState === "failed") {
          setJourneyOutcome("manual-retry");
        } else if (
          isFatalRecordingFailure(captureCauseRef.current) ||
          box.saveState === "error"
        ) {
          setJourneyOutcome("terminal-restart");
        } else if (
          finalizationState &&
          isPendingFinalizationState(finalizationState)
        ) {
          setJourneyOutcome("automatic-retry");
        }
      } catch (failure) {
        const failureCause = cause ?? captureCauseRef.current ?? failure;
        if (cause === undefined && failure instanceof Error) {
          setError(failure.message);
        }
        if (finalization?.state === "failed") {
          setIncompleteFinalization(true);
          setJourneyOutcome("manual-retry");
        } else if (isFatalRecordingFailure(failureCause)) {
          setJourneyOutcome("terminal-restart");
        } else if (outbox.current?.saveState === "error") {
          setJourneyOutcome("terminal-restart");
        } else if (
          isRetryableRecordingFailure(failureCause) ||
          outbox.current?.saveState === "offline"
        ) {
          setJourneyOutcome("automatic-retry");
        } else {
          setJourneyOutcome("terminal-restart");
        }
        throw failure;
      }
    })();
    return captureEndingRef.current;
  };

  const stop = () => {
    const ending = captureEndingRef.current;
    if (ending !== null) {
      return ending;
    }
    revokeRecoveryReset();
    if (recorder.current?.state !== "recording") {
      return Promise.resolve();
    }
    return endCapture(undefined, "candidate");
  };
  const finalize = (input: {
    sessionId: string;
    segments: Array<{ segmentId: string; partCount: number }>;
  }) => {
    revokeRecoveryReset();
    requestStatus(null);
    setFinalizationState({ error: null, state: "finalizing" });
    options.finalizeSession(input, {
      onError: (finalizeError) => {
        finalizationInFlight.current = false;
        const retryable =
          outbox.current?.saveState === "offline" ||
          isRetryableRecordingFailure(finalizeError);
        if (retryable) {
          finalizationAttempted.current = false;
          setFinalizationState({ error: null, state: "queued" });
          return;
        }
        setFinalizationState({
          error: finalizeError.message,
          state: "failed",
        });
        setIncompleteFinalization(true);
        setJourneyOutcome("manual-retry");
        setError(finalizeError.message);
      },
      onSuccess: (result) => {
        finalizationInFlight.current = false;
        const state = normalizeFinalizationStatus(result);
        if (state === null) {
          setFinalizationState({
            error: "Invalid finalization status",
            state: "failed",
          });
          setIncompleteFinalization(true);
          setJourneyOutcome("manual-retry");
          return;
        }
        setFinalizationState({ error: null, state });
        if (state === "ready") {
          setIncompleteFinalization(false);
          ignorePromise(
            (async () => {
              await outbox.current?.deleteSession(input.sessionId);
              sealedPlans.current = sealedPlans.current.filter(
                (plan) => plan.sessionId !== input.sessionId
              );
              finalizationInput.current = null;
              if (
                !sealedPlans.current.length &&
                session.current?.status === "recording"
              ) {
                setFinalizationState(null);
              }
              await submitSealedRef.current?.();
            })()
          );
          return;
        }
        if (isPendingFinalizationState(state)) {
          requestStatus(input.sessionId);
          return;
        }
        requestStatus(null);
      },
    });
  };
  const retryFinalization = async () => {
    if (finalization?.state !== "failed" || !finalizationInput.current) {
      return;
    }
    await submitSealedRef.current?.();
  };
  const resetRecoveredRecording = async () => {
    const currentIds = ids.current;
    if (!canResetRecoveredRecording) {
      throw new Error("Recovered recording cannot be reset");
    }
    if (currentIds === null) {
      throw new Error("Recovered recording cannot be reset");
    }
    await outbox.current?.discardSession(currentIds.sessionId);
    ids.current = null;
    session.current = null;
    setRecovered(false);
    setCaptureEnded(false);
    finalizationInput.current = null;
    finalizationAttempted.current = false;
    setFinalizationState(null);
    setIncompleteFinalization(false);
    setError(null);
    setJourneyOutcome("none");
    setCanResetRecoveredRecording(false);
  };
  return {
    canResetRecoveredRecording,
    captureEnded,
    error,
    finalization:
      options.status === undefined || options.status === null
        ? finalization
        : { error: null, state: options.status },
    hasIncompleteRecordingFinalization,
    hasUnsentRecordingMedia,
    initialize,
    isReady,
    isRecording,
    journeyOutcome,
    recordingPreflightState,
    recordingStopReason,
    recovered,
    resetRecoveredRecording,
    retryFinalization,
    retryRecordingPreflight,
    saveState,
    start,
    stop,
    stream,
  };
}
