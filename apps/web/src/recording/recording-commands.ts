export type RecordingFinalizationState =
  | "queued"
  | "finalizing"
  | "ready"
  | "failed";

export interface RecordingSessionInput {
  recorderMimeType: string | null;
  requestedMimeType: string | null;
  segmentId: string;
  sessionId: string;
}

export interface RecordingFinalizeInput {
  segments: Array<{ partCount: number; segmentId: string }>;
  sessionId: string;
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

export interface RecordingCommands {
  appendSegment: (input: RecordingSessionInput) => Promise<unknown>;
  createSession: (input: RecordingSessionInput) => Promise<unknown>;
  finalizeSession: (input: RecordingFinalizeInput) => Promise<unknown>;
  getManifest: (input: {
    sessionId: string;
  }) => Promise<RecordingManifestLookup>;
  getStatus: (input: {
    sessionId: string;
  }) => Promise<RecordingFinalizationState | null>;
}
