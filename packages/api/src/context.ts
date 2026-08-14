import type {
  AppendRecordingSegmentInput,
  AppendRecordingSegmentResult,
  CreateRecordingSessionInput,
  CreateRecordingSessionResult,
  RecordingFinalizeInput,
  RecordingFinalizeResult,
  RecordingManifest,
  RecordingPlaybackCursor,
  RecordingPlaybackPage,
  RecordingPlaybackSummary,
  RecordingStatus,
} from "@interview-web/db";

export interface RecordingBindings {
  appendRecordingSegment: (
    input: AppendRecordingSegmentInput
  ) => Promise<AppendRecordingSegmentResult>;
  createRecordingSession: (
    input: CreateRecordingSessionInput
  ) => Promise<CreateRecordingSessionResult>;
  enqueueFinalization: (sessionId: string) => Promise<void>;
  finalizeRecording: (
    input: RecordingFinalizeInput
  ) => Promise<RecordingFinalizeResult>;
  getRecordingManifest: (
    sessionId: string
  ) => Promise<RecordingManifest | null>;
  getRecordingPlaybackSummary: (
    sessionId: string
  ) => Promise<RecordingPlaybackSummary | null>;
  getRecordingStatus: (sessionId: string) => Promise<RecordingStatus | null>;
  listRecordingPlaybackSummaries: (input: {
    cursor?: RecordingPlaybackCursor;
  }) => Promise<RecordingPlaybackPage>;
}

export function createContext(options: {
  bindings?: RecordingBindings;
  req?: Request;
}) {
  return { bindings: options.bindings };
}

export type Context = Awaited<ReturnType<typeof createContext>>;
