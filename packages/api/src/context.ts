import type {
  CreateRecordingSessionInput,
  CreateRecordingSessionResult,
  RecordingManifest,
} from "@interview-web/db";

export interface RecordingBindings {
  createRecordingSession: (
    input: CreateRecordingSessionInput
  ) => Promise<CreateRecordingSessionResult>;
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
