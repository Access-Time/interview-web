import { useEffect, useRef } from "react";
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

import { useRecordingStore } from "./recording-store";

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
  hasIncompleteRecordingFinalization: boolean;
  hasUnsentRecordingMedia: boolean;
  initialize: () => Promise<void>;
  integrity: RecordingIntegrity;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  pendingPartCount: number;
  recordingDeliveryPhase: RecordingDeliveryPhase;
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
export type RecordingDeliveryPhase =
  | "idle"
  | "saving"
  | "offline"
  | "reconnecting"
  | "retrying";
export type RecordingStopReason =
  | "candidate"
  | "capacity"
  | "save-failure"
  | null;

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
const INITIAL_RETRY_DELAY_MS = 1000;
const MAX_RETRY_DELAY_MS = 30_000;

export interface RecordingOutboxSnapshot {
  deliveryPhase: RecordingDeliveryPhase;
  hasUnsentMedia: boolean;
  integrity: RecordingIntegrity;
  pendingBytes: number;
  pendingPartCount: number;
  saveState: RecordingSaveState;
}

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
  onError?: (error: unknown) => void
) {
  const pending = new Map<string, RecordingPart>();
  const segmentRankBySession = new Map<string, Map<string, number>>();
  const failed = new Set<string>();
  const failureByKey = new Map<string, unknown>();
  const terminal = new Set<string>();
  let pendingBytes = 0;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  let retryAttempt = 0;
  let flushPromise: Promise<void> | undefined;
  let inFlightPartKey: string | null = null;
  let persistenceFailed = false;
  let disposed = false;
  let online = true;
  let reconnecting = false;
  let integrity: RecordingIntegrity = "ok";
  let onChange: (() => void) | undefined;

  const getPartKey = (part: RecordingPart) =>
    `${part.sessionId}:${part.segmentId}:${part.sequence}`;
  const emit = () => {
    if (!disposed) {
      onChange?.();
    }
  };
  const rememberSessionOrder = (session: RecordingSession) => {
    segmentRankBySession.set(
      session.sessionId,
      new Map(
        session.segments.map((segment, index) => [segment.segmentId, index])
      )
    );
  };
  const rememberPendingPart = (part: RecordingPart) => {
    const partKey = getPartKey(part);
    if (!pending.has(partKey)) {
      pendingBytes += part.blob.size;
    }
    pending.set(partKey, part);
  };
  const acknowledgePendingPart = async (part: RecordingPart) => {
    await store.delete(part);
    const partKey = getPartKey(part);
    if (pending.delete(partKey)) {
      pendingBytes -= part.blob.size;
    }
    failed.delete(partKey);
    failureByKey.delete(partKey);
    emit();
  };
  const getShorterRetryAfterMs = (response?: Response) => {
    const header = response?.headers.get("Retry-After");
    if (!header) {
      return;
    }
    const seconds = Number(header);
    if (Number.isFinite(seconds) && seconds >= 0) {
      return seconds * 1000;
    }
    const timestamp = Date.parse(header);
    if (Number.isFinite(timestamp)) {
      const delayMs = timestamp - Date.now();
      return delayMs >= 0 ? delayMs : undefined;
    }
  };
  const scheduleRetry = (response?: Response) => {
    const retryDelayMs = Math.min(
      MAX_RETRY_DELAY_MS,
      INITIAL_RETRY_DELAY_MS * 2 ** retryAttempt
    );
    const delayMs = Math.min(
      retryDelayMs,
      getShorterRetryAfterMs(response) ?? retryDelayMs
    );
    retryAttempt += 1;
    retryTimer = setTimeout(() => {
      retryTimer = undefined;
      ignorePromise(flush());
    }, delayMs);
    emit();
  };
  const getNextOrderedPart = () => {
    const candidates = [...pending.values()].filter(
      (item) => getPartKey(item) !== inFlightPartKey
    );
    if (candidates.length === 0) {
      return;
    }
    candidates.sort((left, right) => {
      const sessionCmp = left.sessionId.localeCompare(right.sessionId);
      if (sessionCmp !== 0) {
        return sessionCmp;
      }
      const leftRank =
        segmentRankBySession.get(left.sessionId)?.get(left.segmentId) ??
        Number.MAX_SAFE_INTEGER;
      const rightRank =
        segmentRankBySession.get(right.sessionId)?.get(right.segmentId) ??
        Number.MAX_SAFE_INTEGER;
      if (leftRank !== rightRank) {
        return leftRank - rightRank;
      }
      return left.sequence - right.sequence;
    });
    const [nextPart] = candidates;
    if (!nextPart || terminal.has(getPartKey(nextPart))) {
      return;
    }
    return nextPart;
  };
  const recordFailure = (
    partKey: string,
    error: unknown,
    kind: RecordingFailure["recordingFailure"],
    response?: Response
  ): "retryable" | "fatal" => {
    const failure = markRecordingFailure(error, kind);
    failed.add(partKey);
    failureByKey.set(partKey, failure);
    if (kind === "fatal") {
      terminal.add(partKey);
    } else {
      scheduleRetry(response);
    }
    onError?.(failure);
    emit();
    return kind;
  };
  const send = async (
    part: RecordingPart
  ): Promise<"acknowledged" | "retryable" | "fatal"> => {
    const partKey = getPartKey(part);
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
      return recordFailure(partKey, error, "retryable");
    }
    if (!response.ok) {
      const retryable =
        response.status === 408 ||
        response.status === 429 ||
        response.status >= 500;
      return recordFailure(
        partKey,
        `Recording part upload failed (${response.status})`,
        retryable ? "retryable" : "fatal",
        response
      );
    }
    try {
      await acknowledgePendingPart(part);
    } catch (error) {
      return recordFailure(partKey, error, "fatal");
    }
    retryAttempt = 0;
    return "acknowledged";
  };
  const flush = (): Promise<void> => {
    if (flushPromise) {
      return flushPromise;
    }
    if (disposed || !online || retryTimer) {
      return Promise.resolve();
    }

    flushPromise = (async () => {
      while (online && !disposed) {
        const nextPart = getNextOrderedPart();
        if (!nextPart) {
          return;
        }
        inFlightPartKey = getPartKey(nextPart);
        // biome-ignore lint/performance/noAwaitInLoops: a single in-flight upload must finish before the next starts.
        const outcome = await send(nextPart);
        inFlightPartKey = null;
        if (outcome !== "acknowledged") {
          return;
        }
      }
    })().finally(() => {
      inFlightPartKey = null;
      flushPromise = undefined;
    });

    return flushPromise;
  };
  const hydrate = async () => {
    const [parts, sessions] = await Promise.all([
      store.listParts?.() ?? Promise.resolve([]),
      store.listSessions?.() ?? Promise.resolve([]),
    ]);
    for (const item of sessions) {
      rememberSessionOrder(item);
    }
    for (const item of parts) {
      rememberPendingPart(item);
    }
    emit();
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
      const partKey = getPartKey(item);
      if (pending.delete(partKey)) {
        pendingBytes -= item.blob.size;
      }
      failed.delete(partKey);
      failureByKey.delete(partKey);
    }
    for (const item of conflicts) {
      terminal.add(getPartKey(item));
    }
    if (session) {
      rememberSessionOrder(session);
      await store.putSession?.(session);
    }
    emit();
  };
  const recover = async (lookup?: RecordingManifestLookup) => {
    if (online) {
      reconnecting = true;
      emit();
    }
    try {
      const sessions = await (store.listSessions?.() ?? Promise.resolve([]));
      const [stored] = sessions
        .filter((item) => item.status === "recording")
        .sort((a, b) => a.sessionId.localeCompare(b.sessionId));
      if (stored) {
        rememberSessionOrder(stored);
      }
      if (stored && lookup && online) {
        if (lookup.kind === "missing") {
          const session =
            (await store.getSession?.(stored.sessionId)) ?? stored;
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
      reconnecting = false;
      emit();
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
    } finally {
      reconnecting = false;
      emit();
    }
  };
  const recoverAndFlush = recover;
  const assertCanFinalize = () => {
    const message = integrityMessage(integrity);
    if (message) {
      throw markRecordingFailure(message, "fatal");
    }
  };
  const currentDeliveryPhase = (): RecordingDeliveryPhase => {
    if (!online) {
      return "offline";
    }
    if (reconnecting) {
      return "reconnecting";
    }
    if (retryTimer) {
      return "retrying";
    }
    if (pending.size > 0) {
      return "saving";
    }
    return "idle";
  };
  const currentSaveState = (): RecordingSaveState => {
    if (terminal.size || persistenceFailed) {
      return "error";
    }
    if (!online) {
      return "offline";
    }
    return failed.size || retryTimer ? "retrying" : "healthy";
  };
  const snapshot = (): RecordingOutboxSnapshot => ({
    deliveryPhase: currentDeliveryPhase(),
    hasUnsentMedia: pending.size > 0,
    integrity,
    pendingBytes,
    pendingPartCount: pending.size,
    saveState: currentSaveState(),
  });
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
      rememberPendingPart(part);
      emit();
      ignorePromise(flush());
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
        const item = pending.get(partKey);
        if (item && pending.delete(partKey)) {
          pendingBytes -= item.blob.size;
        }
        failed.delete(partKey);
        failureByKey.delete(partKey);
        terminal.delete(partKey);
      }
      segmentRankBySession.delete(sessionId);
      emit();
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
      await Promise.resolve();
      if (flushPromise) {
        await flushPromise;
      }
      if (pending.size && online && !retryTimer) {
        await flush();
      }
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
    recoverAndFlush,
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
      rememberSessionOrder(session);
      rememberPendingPart(part);
      emit();
      ignorePromise(flush());
    },
    async saveSession(session: RecordingSession) {
      rememberSessionOrder(session);
      await store.putSession?.(session);
    },
    get saveState(): RecordingSaveState {
      return currentSaveState();
    },
    async setOnline(
      value: boolean,
      options?: { flush?: boolean; reconnect?: boolean }
    ) {
      online = value;
      if (value && options?.reconnect) {
        reconnecting = true;
      }
      if (!value) {
        reconnecting = false;
        if (retryTimer) {
          clearTimeout(retryTimer);
          retryTimer = undefined;
        }
      }
      if (value && options?.flush !== false) {
        await flush();
      }
      emit();
    },
    get snapshot(): RecordingOutboxSnapshot {
      return snapshot();
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
  const stream = useRecordingStore((state) => state.stream);
  const isReady = useRecordingStore((state) => state.isReady);
  const isRecording = useRecordingStore((state) => state.isRecording);
  const captureEnded = useRecordingStore((state) => state.captureEnded);
  const error = useRecordingStore((state) => state.error);
  const recovered = useRecordingStore((state) => state.recovered);
  const journeyOutcome = useRecordingStore((state) => state.journeyOutcome);
  const canResetRecoveredRecording = useRecordingStore(
    (state) => state.canResetRecoveredRecording
  );
  const finalization = useRecordingStore((state) => state.finalization);
  const integrity = useRecordingStore((state) => state.integrity);
  const pendingPartCount = useRecordingStore((state) => state.pendingPartCount);
  const saveState = useRecordingStore((state) => state.saveState);
  const recordingPreflightState = useRecordingStore(
    (state) => state.recordingPreflightState
  );
  const recordingDeliveryPhase = useRecordingStore(
    (state) => state.recordingDeliveryPhase
  );
  const recordingStopReason = useRecordingStore(
    (state) => state.recordingStopReason
  );
  const hasUnsentRecordingMedia = useRecordingStore(
    (state) => state.hasUnsentRecordingMedia
  );
  const hasIncompleteRecordingFinalization = useRecordingStore(
    (state) => state.hasIncompleteRecordingFinalization
  );

  const { setJourney } = useRecordingStore.getState();
  const setStream = (next: MediaStream | null) => setJourney({ stream: next });
  const setReady = (next: boolean) => setJourney({ isReady: next });
  const setRecording = (next: boolean) => setJourney({ isRecording: next });
  const setCaptureEnded = (next: boolean) => setJourney({ captureEnded: next });
  const setError = (next: string | null) => setJourney({ error: next });
  const setRecovered = (next: boolean) => setJourney({ recovered: next });
  const setJourneyOutcome = (next: RecordingJourneyOutcome) =>
    setJourney({ journeyOutcome: next });
  const setCanResetRecoveredRecording = (next: boolean) =>
    setJourney({ canResetRecoveredRecording: next });
  const setRecordingPreflightState = (next: RecordingPreflightState) =>
    setJourney({ recordingPreflightState: next });
  const setRecordingStopReason = (next: RecordingStopReason) =>
    setJourney({ recordingStopReason: next });
  const setIncompleteFinalization = (next: boolean) =>
    setJourney({ hasIncompleteRecordingFinalization: next });
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
    setJourney({ finalization: value });
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
    useRecordingStore.getState().reset();
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
      }
    );
    outbox.current = box;
    const emitOutbox = () => {
      const {
        deliveryPhase,
        hasUnsentMedia,
        integrity: nextIntegrity,
        pendingPartCount: nextPendingPartCount,
        saveState: nextSaveState,
      } = box.snapshot;
      useRecordingStore.getState().syncOutbox({
        hasUnsentRecordingMedia: hasUnsentMedia,
        integrity: nextIntegrity,
        pendingPartCount: nextPendingPartCount,
        recordingDeliveryPhase: deliveryPhase,
        saveState: nextSaveState,
      });
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
            setIncompleteFinalization(true);
            setJourneyOutcome("manual-retry");
            return;
          }
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
    const applyRecovery = async (lookup?: RecordingManifestLookup) => {
      const recovery = await box.recover(lookup);
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
      useRecordingStore.getState().reset();
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
      if (outbox.current?.integrity === "ok") {
        setError(null);
      }
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
      useRecordingStore.getState().recordingPreflightState !== "ready" ||
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
        if (outbox.current?.integrity === "ok") {
          setError(null);
        }
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
          outbox.current?.snapshot.pendingBytes ?? 0,
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
        box.assertCanFinalize();
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

        const finalizationState =
          useRecordingStore.getState().finalization?.state;
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
        if (useRecordingStore.getState().finalization?.state === "failed") {
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
    outbox.current?.assertCanFinalize();
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
    if (
      useRecordingStore.getState().finalization?.state !== "failed" ||
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
    integrity,
    isReady,
    isRecording,
    journeyOutcome,
    pendingPartCount,
    recordingDeliveryPhase,
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
