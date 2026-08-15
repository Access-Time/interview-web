import { create } from "zustand";
import type {
  RecordingFinalizationResult,
  RecordingIntegrity,
  RecordingJourneyOutcome,
  RecordingSaveState,
} from "./live-recording";

export interface RecordingOutboxView {
  integrity: RecordingIntegrity;
  pendingPartCount: number;
  saveState: RecordingSaveState;
}

export interface RecordingJourneyState {
  canResetRecoveredRecording: boolean;
  captureEnded: boolean;
  error: string | null;
  finalization: RecordingFinalizationResult | null;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  recovered: boolean;
  stream: MediaStream | null;
}

export interface RecordingStore
  extends RecordingJourneyState,
    RecordingOutboxView {
  reset: () => void;
  setJourney: (patch: Partial<RecordingJourneyState>) => void;
  syncOutbox: (view: RecordingOutboxView) => void;
}

const initialJourney: RecordingJourneyState = {
  canResetRecoveredRecording: false,
  captureEnded: false,
  error: null,
  finalization: null,
  isReady: false,
  isRecording: false,
  journeyOutcome: "none",
  recovered: false,
  stream: null,
};

const initialOutbox: RecordingOutboxView = {
  integrity: "ok",
  pendingPartCount: 0,
  saveState: "healthy",
};

export const useRecordingStore = create<RecordingStore>((set) => ({
  ...initialJourney,
  ...initialOutbox,
  reset: () => set({ ...initialJourney, ...initialOutbox }),
  setJourney: (patch) => set(patch),
  syncOutbox: (view) => set(view),
}));
