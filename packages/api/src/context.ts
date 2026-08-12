import type {
  CreateRecordingSessionInput,
  RecordingManifest,
} from "@interview-web/db";

export interface RecordingBindings {
  createRecordingSession: (
    input: CreateRecordingSessionInput
  ) => Promise<{ segmentId: string; sessionId: string }>;
  getRecordingManifest: (
    sessionId: string
  ) => Promise<RecordingManifest | null>;
}

export function createContext(options: {
  bindings?: RecordingBindings;
  req?: Request;
}) {
  return { bindings: options.bindings };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
