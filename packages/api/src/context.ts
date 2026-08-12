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
  operatorSecret: string;
}

export function createContext(options: {
  req: Request;
  bindings?: RecordingBindings;
}) {
  const authorization = options.req.headers.get("Authorization");
  const operatorAuthorized =
    options.bindings !== undefined &&
    authorization === `Bearer ${options.bindings.operatorSecret}`;

  return {
    bindings: options.bindings,
    operatorAuthorized,
  };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
