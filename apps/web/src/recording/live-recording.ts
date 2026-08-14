import {
  useCallback,
  useEffect,
  useRef,
  useState,
  useSyncExternalStore,
} from "react";

export type RecordingSaveState = "healthy" | "retrying" | "offline" | "error";
export type RecordingIntegrity = "ok" | "gap" | "conflict";
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
  initialize: () => Promise<void>;
  integrity: RecordingIntegrity;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  pendingPartCount: number;
  recovered: boolean;
  resetRecoveredRecording: () => Promise<void>;
  retryFinalization: () => Promise<void>;
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

const partIdentity = (segmentId: string, sequence: number) =>
  `${segmentId}:${sequence}`;

export async function recordingBlobChecksum(blob: Blob): Promise<string> {
  return Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
    ),
    (byte) => byte.toString(16).padStart(2, "0")
  ).join("");
}

export function integrityMessage(integrity: RecordingIntegrity): string | null {
  if (integrity === "conflict") {
    return "This recording has conflicting parts and cannot be finalized";
  }
  if (integrity === "gap") {
    return "This recording is missing ordered parts and cannot be finalized";
  }
  return null;
}

function sequencesAreContiguous(sequences: Iterable<number>): boolean {
  const unique = [...new Set(sequences)].sort((a, b) => a - b);
  return unique.every((sequence, index) => sequence === index);
}

function acknowledgedChecksums(manifest: RecordingManifestView | null) {
  const checksums = new Map<string, string>();
  for (const segment of manifest?.segments ?? []) {
    for (const part of segment.parts) {
      checksums.set(
        partIdentity(segment.id, part.sequence),
        part.checksum.toLowerCase()
      );
    }
  }
  return checksums;
}

function segmentUnionSequences(
  segmentId: string,
  manifest: RecordingManifestView | null,
  remaining: RecordingPart[]
) {
  const sequences = new Set<number>();
  const remote = manifest?.segments.find((segment) => segment.id === segmentId);
  for (const part of remote?.parts ?? []) {
    sequences.add(part.sequence);
  }
  for (const part of remaining) {
    if (part.segmentId === segmentId) {
      sequences.add(part.sequence);
    }
  }
  return sequences;
}

function refreshedPartCount(
  current: number,
  sequences: ReadonlySet<number>
): number {
  if (sequences.size === 0) {
    return current;
  }
  return Math.max(current, Math.max(...sequences) + 1);
}

function classifyIntegrity(
  conflicts: RecordingPart[],
  session: RecordingSession,
  manifest: RecordingManifestView,
  remaining: RecordingPart[]
): RecordingIntegrity {
  if (conflicts.length > 0) {
    return "conflict";
  }
  for (const segment of session.segments) {
    const sequences = segmentUnionSequences(
      segment.segmentId,
      manifest,
      remaining
    );
    if (segment.partCount === 0 && sequences.size === 0) {
      continue;
    }
    if (
      !sequencesAreContiguous(sequences) ||
      sequences.size !== segment.partCount
    ) {
      return "gap";
    }
  }
  return "ok";
}

export async function reconcileRecordingParts(input: {
  localParts: RecordingPart[];
  localSession: RecordingSession | null | undefined;
  manifest: RecordingManifestView | null;
}): Promise<{
  conflicts: RecordingPart[];
  drop: RecordingPart[];
  integrity: RecordingIntegrity;
  keep: RecordingPart[];
  session: RecordingSession | null;
}> {
  const remote = acknowledgedChecksums(input.manifest);
  const checksumEntries: Array<readonly [string, string]> = [];
  if (input.manifest) {
    for (const part of input.localParts) {
      const identity = partIdentity(part.segmentId, part.sequence);
      if (!remote.has(identity)) {
        continue;
      }
      // biome-ignore lint/performance/noAwaitInLoops: hash acknowledged parts sequentially to bound memory.
      const checksum = await recordingBlobChecksum(part.blob);
      checksumEntries.push([identity, checksum]);
    }
  }
  const localChecksums = new Map(checksumEntries);
  const drop: RecordingPart[] = [];
  const keep: RecordingPart[] = [];
  const conflicts: RecordingPart[] = [];

  for (const part of input.localParts) {
    if (!input.manifest) {
      keep.push(part);
      continue;
    }
    const acknowledged = remote.get(
      partIdentity(part.segmentId, part.sequence)
    );
    if (acknowledged === undefined) {
      keep.push(part);
      continue;
    }
    const checksum = localChecksums.get(
      partIdentity(part.segmentId, part.sequence)
    );
    if (checksum === acknowledged) {
      drop.push(part);
      continue;
    }
    conflicts.push(part);
  }

  const remaining = [...keep, ...conflicts];
  const session = input.localSession
    ? {
        ...input.localSession,
        segments: input.localSession.segments.map((segment) => ({
          ...segment,
          partCount: refreshedPartCount(
            segment.partCount,
            segmentUnionSequences(segment.segmentId, input.manifest, remaining)
          ),
        })),
      }
    : null;

  const integrity =
    input.manifest && session
      ? classifyIntegrity(conflicts, session, input.manifest, remaining)
      : "ok";

  return { conflicts, drop, integrity, keep, session };
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

const MIME_TYPES = [
  "video/webm;codecs=vp9,opus",
  "video/webm;codecs=vp8,opus",
  'video/mp4;codecs="avc1.42E01E,mp4a.40.2"',
  "video/mp4",
  "video/webm",
];
const RETRY_DELAY = 1000;
const ignorePromise = (promise: Promise<unknown>) => {
  promise.catch(() => undefined);
};

function browserStore(): RecordingRecoveryStore {
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
  return {
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
}

export function createLiveRecordingOutbox(
  store: RecordingRecoveryStore = browserStore(),
  request: typeof fetch = fetch,
  onError?: (error: unknown) => void
) {
  const active = new Set<string>();
  const pending = new Map<string, RecordingPart>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Set<string>();
  const failureByKey = new Map<string, unknown>();
  const terminal = new Set<string>();
  let persistenceFailed = false;
  let disposed = false;
  let online = true;
  let integrity: RecordingIntegrity = "ok";
  let onChange: (() => void) | undefined;

  const key = (part: RecordingPart) =>
    `${part.sessionId}:${part.segmentId}:${part.sequence}`;
  const send = async (part: RecordingPart) => {
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
      throw markRecordingFailure(
        `Recording part upload failed (${response.status})`,
        response.status === 408 ||
          response.status === 429 ||
          response.status >= 500
          ? "retryable"
          : "fatal"
      );
    }
    try {
      await store.delete(part);
    } catch (error) {
      throw markRecordingFailure(error, "fatal");
    }
    if (!disposed) {
      pending.delete(key(part));
      failed.delete(key(part));
      failureByKey.delete(key(part));
      onChange?.();
    }
  };
  const flush = async () => {
    if (disposed || !online) {
      return;
    }
    const attempts: Promise<void>[] = [];
    for (const part of pending.values()) {
      const partKey = key(part);
      if (active.has(partKey) || terminal.has(partKey)) {
        continue;
      }
      active.add(partKey);
      const attempt = send(part)
        .catch((error: unknown) => {
          if (disposed) {
            return;
          }
          failed.add(partKey);
          failureByKey.set(partKey, error);
          const retryable = isRetryableRecordingFailure(error);
          if (!retryable) {
            terminal.add(partKey);
          }
          onError?.(error);
          if (online && retryable && !retryTimer) {
            retryTimer = setTimeout(() => {
              retryTimer = undefined;
              ignorePromise(flush());
            }, RETRY_DELAY);
          }
        })
        .finally(() => {
          if (!disposed) {
            active.delete(partKey);
            onChange?.();
          }
        });
      attempts.push(attempt);
    }
    await Promise.all(attempts);
  };
  const hydrate = async () => {
    const parts = (await store.listParts?.()) ?? [];
    for (const item of parts) {
      pending.set(key(item), item);
    }
  };
  const applyReconcile = async (
    result: Awaited<ReturnType<typeof reconcileRecordingParts>>
  ) => {
    const { conflicts, drop, integrity: nextIntegrity, session } = result;
    integrity = nextIntegrity;
    await Promise.all(
      drop.map(async (item) => {
        try {
          await store.delete(item);
        } catch {
          /* Keep reconcile moving if a single IndexedDB delete fails. */
        }
      })
    );
    for (const item of drop) {
      pending.delete(key(item));
      failed.delete(key(item));
      failureByKey.delete(key(item));
    }
    for (const item of conflicts) {
      terminal.add(key(item));
    }
    if (session) {
      await store.putSession?.(session);
    }
    if (!disposed) {
      onChange?.();
    }
  };
  const recover = async (
    getManifest?: (input: {
      sessionId: string;
    }) => Promise<RecordingManifestLookup>
  ) => {
    const sessions = await (store.listSessions?.() ?? Promise.resolve([]));
    const [stored] = sessions
      .filter((item) => item.status === "recording")
      .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
    if (stored && getManifest && online) {
      const lookup = await getManifest({ sessionId: stored.sessionId });
      if (lookup.kind === "missing") {
        const session = (await store.getSession?.(stored.sessionId)) ?? stored;
        return { integrity, missing: true, recovered: true, session };
      }
      const localParts = [...pending.values()].filter(
        (item) => item.sessionId === stored.sessionId
      );
      await applyReconcile(
        await reconcileRecordingParts({
          localParts,
          localSession: stored,
          manifest: lookup.manifest,
        })
      );
    }
    await flush();
    const session =
      stored === undefined
        ? null
        : ((await store.getSession?.(stored.sessionId)) ?? stored);
    return {
      integrity,
      missing: false,
      recovered: Boolean(stored),
      session,
    };
  };
  const assertCanFinalize = () => {
    const message = integrityMessage(integrity);
    if (message) {
      throw markRecordingFailure(message, "fatal");
    }
  };
  return {
    async add(part: RecordingPart) {
      try {
        await store.put(part);
      } catch (error) {
        persistenceFailed = true;
        const failure = markRecordingFailure(error, "fatal");
        onError?.(failure);
        throw failure;
      }
      if (disposed) {
        return;
      }
      pending.set(key(part), part);
      await flush();
    },
    assertCanFinalize,
    async deleteSession(sessionId: string) {
      await store.deleteSession?.(sessionId);
    },
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: cleanup covers every in-memory failure index.
    async discardSession(sessionId: string) {
      await store.discardSession(sessionId);
      const keys = new Set<string>();
      for (const [partKey, item] of pending) {
        if (item.sessionId === sessionId) {
          keys.add(partKey);
        }
      }
      for (const partKey of failed) {
        if (partKey.startsWith(`${sessionId}:`)) {
          keys.add(partKey);
        }
      }
      for (const partKey of failureByKey.keys()) {
        if (partKey.startsWith(`${sessionId}:`)) {
          keys.add(partKey);
        }
      }
      for (const partKey of terminal) {
        if (partKey.startsWith(`${sessionId}:`)) {
          keys.add(partKey);
        }
      }
      for (const partKey of keys) {
        pending.delete(partKey);
        failed.delete(partKey);
        failureByKey.delete(partKey);
        terminal.delete(partKey);
      }
      onChange?.();
    },
    dispose() {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      retryTimer = undefined;
      onChange = undefined;
    },
    async drain() {
      await flush();
      if (pending.size) {
        const failure = failureByKey.values().next().value;
        throw markRecordingFailure(
          failure ??
            (online
              ? "Recording uploads are still pending"
              : "Recording uploads are pending while offline"),
          failure && !isRetryableRecordingFailure(failure)
            ? "fatal"
            : "retryable"
        );
      }
    },
    getSessions() {
      return store.listSessions?.() ?? [];
    },
    hydrate,
    get integrity() {
      return integrity;
    },
    get pendingCount() {
      return pending.size;
    },
    recover,
    async savePartAndSession(part: RecordingPart, session: RecordingSession) {
      try {
        if (store.putPartAndSession) {
          await store.putPartAndSession(part, session);
        } else {
          await store.put(part);
          await store.putSession?.(session);
        }
      } catch (error) {
        persistenceFailed = true;
        const failure = markRecordingFailure(error, "fatal");
        onError?.(failure);
        throw failure;
      }
      pending.set(key(part), part);
      await flush();
    },
    async saveSession(session: RecordingSession) {
      await store.putSession?.(session);
    },
    get saveState(): RecordingSaveState {
      if (terminal.size || persistenceFailed) {
        return "error";
      }
      if (!online) {
        return "offline";
      }
      return failed.size ? "retrying" : "healthy";
    },
    async setOnline(value: boolean, options?: { flush?: boolean }) {
      online = value;
      if (!value && retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (value && options?.flush !== false) {
        await flush();
      }
      if (!disposed) {
        onChange?.();
      }
    },
    subscribe(callback: () => void) {
      onChange = callback;
      return () => {
        if (onChange === callback) {
          onChange = undefined;
        }
      };
    },
  };
}

interface OutboxSnapshot {
  integrity: RecordingIntegrity;
  pendingPartCount: number;
  saveState: RecordingSaveState;
}

const IDLE_OUTBOX_SNAPSHOT: OutboxSnapshot = {
  integrity: "ok",
  pendingPartCount: 0,
  saveState: "healthy",
};

function snapshotOutbox(
  box: ReturnType<typeof createLiveRecordingOutbox> | null
): OutboxSnapshot {
  return box
    ? {
        integrity: box.integrity,
        pendingPartCount: box.pendingCount,
        saveState: box.saveState,
      }
    : IDLE_OUTBOX_SNAPSHOT;
}

export interface UseLiveRecordingOptions {
  appendSegment: (input: {
    sessionId: string;
    segmentId: string;
    requestedMimeType: string | null;
    recorderMimeType: string | null;
  }) => Promise<unknown>;
  createSession: (input: {
    sessionId: string;
    segmentId: string;
    requestedMimeType: string | null;
    recorderMimeType: string | null;
  }) => Promise<unknown>;
  finalizeSession: (input: {
    sessionId: string;
    segments: Array<{ segmentId: string; partCount: number }>;
  }) => Promise<unknown>;
  getFinalizationStatus?: (input: {
    sessionId: string;
  }) => Promise<RecordingFinalizationStatus>;
  getManifest?: (input: {
    sessionId: string;
  }) => Promise<RecordingManifestLookup>;
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
  const sequence = useRef(0);
  const processing = useRef<Promise<void>[]>([]);
  const ids = useRef<{ sessionId: string; segmentId: string } | null>(null);
  const session = useRef<RecordingSession | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lifecycle = useRef<boolean | undefined>(undefined);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isReady, setReady] = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [captureEnded, setCaptureEnded] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [recovered, setRecovered] = useState(false);
  const [journeyOutcome, setJourneyOutcome] =
    useState<RecordingJourneyOutcome>("none");
  const [canResetRecoveredRecording, setCanResetRecoveredRecording] =
    useState(false);
  const [finalization, setFinalization] =
    useState<RecordingFinalizationResult | null>(null);
  const finalizationInput = useRef<{
    sessionId: string;
    segments: Array<{ segmentId: string; partCount: number }>;
  } | null>(null);
  const finalizationAttempted = useRef(false);
  const finalizationRef = useRef<RecordingFinalizationResult | null>(null);
  const pollTimer = useRef<ReturnType<typeof setTimeout> | undefined>(
    undefined
  );
  const pollGeneration = useRef(0);
  const recoveryGeneration = useRef(0);
  const recoveryPromise = useRef<Promise<void> | null>(null);
  const captureEndingRef = useRef<Promise<void> | null>(null);
  const finalizationInFlight = useRef<Promise<void> | null>(null);
  const sealedPumpLock = useRef(false);
  const sealedPlans = useRef<
    Array<{
      sessionId: string;
      segments: Array<{ segmentId: string; partCount: number }>;
    }>
  >([]);
  const submitSealedRef = useRef<(() => Promise<void>) | null>(null);
  const outboxSnapshot = useRef(IDLE_OUTBOX_SNAPSHOT);
  const outboxListeners = useRef(new Set<() => void>());
  const subscribeOutbox = useCallback((onStoreChange: () => void) => {
    outboxListeners.current.add(onStoreChange);
    return () => {
      outboxListeners.current.delete(onStoreChange);
    };
  }, []);
  const getOutboxSnapshot = useCallback(() => outboxSnapshot.current, []);
  const outboxView = useSyncExternalStore(
    subscribeOutbox,
    getOutboxSnapshot,
    () => IDLE_OUTBOX_SNAPSHOT
  );

  const cancelFinalizationPolling = () => {
    pollGeneration.current += 1;
    // biome-ignore lint/suspicious/noUnnecessaryConditions: timer refs are populated at runtime.
    if (pollTimer.current) {
      clearTimeout(pollTimer.current);
    }
    pollTimer.current = undefined;
  };

  const setFinalizationState = (value: RecordingFinalizationResult | null) => {
    finalizationRef.current = value;
    setFinalization(value);
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
    if (
      !sealedPlans.current.length &&
      session.current?.status === "recording"
    ) {
      setFinalizationState(null);
    }
    ignorePromise(submitSealedRef.current?.() ?? Promise.resolve());
  };

  const pollFinalization = async (generation: number) => {
    const input = finalizationInput.current;
    const getStatus = options.getFinalizationStatus;
    const isDisposed = () => lifecycle.current === true;
    if (
      // biome-ignore lint/suspicious/noUnnecessaryConditions: refs and optional callbacks are runtime state.
      !(input && getStatus) ||
      generation !== pollGeneration.current ||
      isDisposed()
    ) {
      return;
    }
    try {
      const status = normalizeFinalizationStatus(await getStatus(input));
      if (status === null) {
        throw new Error("Invalid finalization status");
      }
      if (generation !== pollGeneration.current || isDisposed()) {
        return;
      }
      setFinalizationState({ error: null, state: status });
      if (status === "ready") {
        await completeReadyFinalization(input);
      }
      if (status === "queued" || status === "finalizing") {
        pollTimer.current = setTimeout(() => {
          pollTimer.current = undefined;
          ignorePromise(pollFinalization(generation));
        }, RETRY_DELAY);
      }
    } catch {
      if (generation !== pollGeneration.current || isDisposed()) {
        return;
      }
      pollTimer.current = setTimeout(() => {
        pollTimer.current = undefined;
        ignorePromise(pollFinalization(generation));
      }, RETRY_DELAY);
    }
  };

  const beginFinalizationPolling = () => {
    cancelFinalizationPolling();
    const generation = pollGeneration.current;
    if (options.getFinalizationStatus) {
      pollTimer.current = setTimeout(() => {
        pollTimer.current = undefined;
        ignorePromise(pollFinalization(generation));
      }, RETRY_DELAY);
    }
  };

  // biome-ignore lint/correctness/useExhaustiveDependencies: lifecycle effect intentionally runs once; mutable refs carry runtime callbacks.
  useEffect(() => {
    lifecycle.current = false;
    const isDisposed = () => lifecycle.current === true;
    const box = createLiveRecordingOutbox(undefined, undefined, (cause) => {
      if (isDisposed()) {
        return;
      }
      if (isRetryableRecordingFailure(cause)) {
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      ignorePromise(endCapture(cause));
    });
    outbox.current = box;
    const emitOutbox = () => {
      const next = snapshotOutbox(box);
      const { current } = outboxSnapshot;
      if (
        current.integrity !== next.integrity ||
        current.pendingPartCount !== next.pendingPartCount ||
        current.saveState !== next.saveState
      ) {
        outboxSnapshot.current = next;
      }
      for (const listener of outboxListeners.current) {
        listener();
      }
    };
    const unsubscribe = box.subscribe(() => {
      emitOutbox();
      ignorePromise(submitSealedRef.current?.() ?? Promise.resolve());
    });
    emitOutbox();
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
          try {
            box.assertCanFinalize();
          } catch (cause) {
            const message =
              cause instanceof Error ? cause.message : String(cause);
            setError(message);
            setFinalizationState({ error: message, state: "failed" });
            return;
          }
          finalizationInput.current = plan;
          setFinalizationState({ error: null, state: "queued" });
          try {
            // biome-ignore lint/performance/noAwaitInLoops: each plan must complete before the next is submitted.
            await box.drain();
            finalizationAttempted.current = true;
            const attempt = finalize(plan);
            finalizationInFlight.current = attempt;
            await attempt;
            finalizationInFlight.current = null;
            if (finalizationRef.current?.state !== "ready") {
              return;
            }
            finalizationAttempted.current = false;
          } catch (cause) {
            finalizationInFlight.current = null;
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
    const applyRecovery = async () => {
      const { getManifest } = options;
      const manifestLookup = getManifest
        ? async (input: { sessionId: string }) => {
            const result = await getManifest(input);
            if (result === null) {
              throw new Error("Recording manifest lookup unavailable");
            }
            if ("kind" in result) {
              return result;
            }
            return { kind: "found", manifest: result } as const;
          }
        : undefined;
      const recovery = await box.recover(manifestLookup);
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
      const message = integrityMessage(recovery.integrity);
      if (message) {
        setError(message);
        setJourneyOutcome("terminal-restart");
        setCanResetRecoveredRecording(Boolean(recovery.session && ids.current));
      } else if (recovery.missing) {
        setJourneyOutcome("missing-recovery");
        setCanResetRecoveredRecording(Boolean(recovery.session && ids.current));
      } else {
        revokeRecoveryReset();
      }
      return recovery;
    };
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
    const online = () => {
      ignorePromise(
        enqueueRecovery(async () => {
          await box.setOnline(true, { flush: false });
          await applyRecovery();
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
        await applyRecovery();
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
      unsubscribe();
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
      if (outbox.current?.integrity === "ok") {
        setError(null);
      }
    } catch (cause) {
      if (lifecycle.current === true) {
        return;
      }
      setError(
        `Unable to access camera and microphone: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
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
    const instance = requested
      ? new MediaRecorder(stream, { mimeType: requested })
      : new MediaRecorder(stream);
    captureEndingRef.current = null;
    setCaptureEnded(false);
    cancelFinalizationPolling();
    finalizationAttempted.current = false;
    finalizationInput.current = null;
    setFinalizationState(null);
    ids.current = { segmentId, sessionId };
    sequence.current = 0;
    recorder.current = instance;
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
    if (recordingRemoteAction(previous, resumeTail) === "append") {
      await options.appendSegment(remoteMetadata);
    } else {
      await options.createSession(remoteMetadata);
    }
    if (lifecycle.current === true) {
      return;
    }
    instance.ondataavailable = (event) => {
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
      const work = outbox.current.savePartAndSession(part, updatedSession);
      processing.current.push(work);
      work.then(
        () => {
          processing.current = processing.current.filter(
            (item) => item !== work
          );
        },
        () => {
          processing.current = processing.current.filter(
            (item) => item !== work
          );
        }
      );
    };
    instance.onerror = (event) => {
      if (lifecycle.current !== true) {
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
    if (lifecycle.current === false || lifecycle.current === undefined) {
      setRecording(true);
      if (outbox.current?.integrity === "ok") {
        setError(null);
      }
    }
  };
  const endCapture = (cause?: unknown): Promise<void> => {
    // biome-ignore lint/complexity/noExcessiveCognitiveComplexity: capture shutdown serializes media, persistence, and finalization failures.
    captureEndingRef.current ??= (async () => {
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
        if (instance === undefined) {
          // No recorder was created before capture shutdown.
        } else if (instance.state !== "inactive") {
          await new Promise<void>((resolve) => {
            const done = () => resolve();
            instance.addEventListener("stop", done, { once: true });
            instance.stop();
          });
        }

        while (processing.current.length) {
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
        box.assertCanFinalize();
        session.current = {
          ...currentSession,
          segments: plan.segments,
          status: "sealed",
        };
        await box.saveSession(session.current);
        sealedPlans.current.push(plan);
        finalizationInput.current ??= plan;
        setFinalizationState({ error: null, state: "queued" });
        await submitSealedRef.current?.();

        const finalizationState = finalizationRef.current?.state;
        if (finalizationState === "failed") {
          setJourneyOutcome("manual-retry");
        } else if (
          finalizationState &&
          isPendingFinalizationState(finalizationState)
        ) {
          setJourneyOutcome("automatic-retry");
        }
      } catch (failure) {
        const failureCause = cause ?? failure;
        if (failure instanceof Error) {
          setError(failure.message);
        }
        if (
          isRetryableRecordingFailure(failureCause) ||
          outbox.current?.saveState === "offline"
        ) {
          setJourneyOutcome("automatic-retry");
        } else if (finalizationRef.current?.state === "failed") {
          setJourneyOutcome("manual-retry");
        } else {
          setJourneyOutcome("terminal-restart");
        }
        throw failure;
      }
    })();
    return captureEndingRef.current;
  };

  const stop = () => {
    revokeRecoveryReset();
    const ending = captureEndingRef.current;
    if (ending !== null) {
      return ending;
    }
    if (recorder.current?.state !== "recording") {
      return Promise.resolve();
    }
    return endCapture();
  };
  const finalize = async (input: {
    sessionId: string;
    segments: Array<{ segmentId: string; partCount: number }>;
  }) => {
    revokeRecoveryReset();
    outbox.current?.assertCanFinalize();
    cancelFinalizationPolling();
    setFinalizationState({ error: null, state: "finalizing" });
    try {
      const result = await options.finalizeSession(input);
      const state = normalizeFinalizationStatus(result);
      if (state === null) {
        throw new Error("Invalid finalization status");
      }
      setFinalizationState({ error: null, state });
      if (state === "ready") {
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
        ignorePromise(submitSealedRef.current?.() ?? Promise.resolve());
      }
      if (isPendingFinalizationState(state)) {
        beginFinalizationPolling();
      }
    } catch (cause) {
      const retryable =
        outbox.current?.saveState === "offline" ||
        isRetryableRecordingFailure(cause);
      if (retryable) {
        finalizationAttempted.current = false;
        setFinalizationState({ error: null, state: "queued" });
        throw cause;
      }
      setFinalizationState({
        error: cause instanceof Error ? cause.message : String(cause),
        state: "failed",
      });
      throw cause;
    }
  };
  const retryFinalization = async () => {
    if (
      finalizationRef.current?.state !== "failed" ||
      !finalizationInput.current
    ) {
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
    setError(null);
    setJourneyOutcome("none");
    setCanResetRecoveredRecording(false);
  };
  return {
    canResetRecoveredRecording,
    captureEnded,
    error,
    finalization,
    initialize,
    integrity: outboxView.integrity,
    isReady,
    isRecording,
    journeyOutcome,
    pendingPartCount: outboxView.pendingPartCount,
    recovered,
    resetRecoveredRecording,
    retryFinalization,
    saveState: outboxView.saveState,
    start,
    stop,
    stream,
  };
}
