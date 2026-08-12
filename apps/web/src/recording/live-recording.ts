import { useEffect, useRef, useState } from "react";

export type RecordingSaveState = "healthy" | "retrying" | "offline" | "error";

export interface UseLiveRecordingResult {
  error: string | null;
  initialize: () => Promise<void>;
  isReady: boolean;
  isRecording: boolean;
  pendingPartCount: number;
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

interface PartStore {
  delete: (part: RecordingPart) => Promise<void>;
  put: (part: RecordingPart) => Promise<void>;
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

function browserStore(): PartStore {
  let database: Promise<IDBDatabase> | undefined;
  const open = () => {
    database ??= new Promise((resolve, reject) => {
      const request = indexedDB.open("live-recording-outbox", 1);
      request.onupgradeneeded = () => {
        request.result.createObjectStore("parts", { keyPath: "id" });
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
    action: (store: IDBObjectStore) => void
  ) =>
    open().then(
      (db) =>
        new Promise<void>((resolve, reject) => {
          const tx = db.transaction("parts", mode);
          action(tx.objectStore("parts"));
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
    put: (part) =>
      transaction("readwrite", (store) =>
        store.put({ ...part, id: key(part) })
      ),
  };
}

export function createLiveRecordingOutbox(
  store: PartStore = browserStore(),
  request: typeof fetch = fetch,
  onError?: (error: unknown) => void
) {
  const active = new Set<string>();
  const pending = new Map<string, RecordingPart>();
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  const failed = new Set<string>();
  const terminal = new Set<string>();
  let persistenceFailed = false;
  let disposed = false;
  let online = true;
  let onChange: (() => void) | undefined;

  const key = (part: RecordingPart) =>
    `${part.sessionId}:${part.segmentId}:${part.sequence}`;
  const checksum = async (blob: Blob) =>
    Array.from(
      new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer())
      ),
      (byte) => byte.toString(16).padStart(2, "0")
    ).join("");
  const send = async (part: RecordingPart) => {
    let response: Response;
    try {
      response = await request(
        `/api/recordings/${encodeURIComponent(part.sessionId)}/segments/${encodeURIComponent(part.segmentId)}/parts/${part.sequence}`,
        {
          body: part.blob,
          headers: {
            "Content-Type": part.mediaType || "application/octet-stream",
            "X-Content-SHA256": await checksum(part.blob),
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
    dispose() {
      disposed = true;
      if (retryTimer) {
        clearTimeout(retryTimer);
      }
      retryTimer = undefined;
      onChange = undefined;
    },
    get pendingCount() {
      return pending.size;
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
    async setOnline(value: boolean) {
      online = value;
      if (!value && retryTimer) {
        clearTimeout(retryTimer);
        retryTimer = undefined;
      }
      if (value) {
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

export function useLiveRecording(options: {
  createSession: (input: {
    sessionId: string;
    segmentId: string;
    requestedMimeType: string | null;
    recorderMimeType: string | null;
  }) => Promise<unknown>;
}): UseLiveRecordingResult {
  const outbox = useRef<ReturnType<typeof createLiveRecordingOutbox> | null>(
    null
  );
  const recorder = useRef<MediaRecorder | undefined>(undefined);
  const sequence = useRef(0);
  const processing = useRef<Promise<void>[]>([]);
  const ids = useRef<{ sessionId: string; segmentId: string } | null>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const lifecycle = useRef<boolean | undefined>(undefined);
  const [stream, setStream] = useState<MediaStream | null>(null);
  const [isReady, setReady] = useState(false);
  const [isRecording, setRecording] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [, redraw] = useState(0);

  useEffect(() => {
    lifecycle.current = false;
    const box = createLiveRecordingOutbox(undefined, undefined, (cause) => {
      if (lifecycle.current === true) {
        return;
      }
      if (isRetryableRecordingFailure(cause)) {
        return;
      }
      setError(cause instanceof Error ? cause.message : String(cause));
      if (recorder.current?.state !== "inactive") {
        recorder.current?.stop();
      }
    });
    outbox.current = box;
    const unsubscribe = box.subscribe(() => redraw((value) => value + 1));
    const online = () => box.setOnline(true);
    const offline = () => box.setOnline(false);
    window.addEventListener("online", online);
    window.addEventListener("offline", offline);
    box.setOnline(navigator.onLine);
    return () => {
      lifecycle.current = true;
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
      setError(null);
    } catch (cause) {
      if (lifecycle.current === true) {
        return;
      }
      setError(
        `Unable to access camera and microphone: ${cause instanceof Error ? cause.message : String(cause)}`
      );
    }
  };
  const start = async () => {
    if (!stream) {
      throw new Error("Recording is not initialized");
    }
    const requested =
      MIME_TYPES.find((type) => MediaRecorder.isTypeSupported(type)) ?? null;
    const sessionId = crypto.randomUUID();
    const segmentId = crypto.randomUUID();
    const instance = requested
      ? new MediaRecorder(stream, { mimeType: requested })
      : new MediaRecorder(stream);
    ids.current = { segmentId, sessionId };
    sequence.current = 0;
    recorder.current = instance;
    await options.createSession({
      recorderMimeType: instance.mimeType || null,
      requestedMimeType: requested,
      segmentId,
      sessionId,
    });
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
      const work = outbox.current.add(part);
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
    instance.onerror = () => {
      if (lifecycle.current !== true) {
        setError("Recording failed while capturing media");
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
      setError(null);
    }
  };
  const stop = async () => {
    if (recorder.current?.state !== "recording") {
      return;
    }
    const instance = recorder.current;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      instance.addEventListener("stop", done, { once: true });
      instance.stop();
    });
    await Promise.all(processing.current);
  };
  return {
    error,
    initialize,
    isReady,
    isRecording,
    pendingPartCount: outbox.current?.pendingCount ?? 0,
    saveState: outbox.current?.saveState ?? "healthy",
    start,
    stop,
    stream,
  };
}
