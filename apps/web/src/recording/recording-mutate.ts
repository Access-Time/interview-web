import type { ApiErrors } from "@/utils/orpc";

export type RecordingMutate<TInput, TOutput, TError> = (
  input: TInput,
  callbacks: {
    onError: (error: TError) => void;
    onSuccess: (data: TOutput) => void;
  }
) => void;

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

export type CreateRecordingMutate = RecordingMutate<
  RecordingSessionInput,
  unknown,
  ApiErrors["recording"]["create"]
>;

export type AppendSegmentMutate = RecordingMutate<
  RecordingSessionInput,
  unknown,
  ApiErrors["recording"]["appendSegment"]
>;

export type FinalizeRecordingMutate = RecordingMutate<
  RecordingFinalizeInput,
  unknown,
  ApiErrors["recording"]["finalize"]
>;
