import { create } from "zustand";
import type {
  RecordingDeliveryPhase,
  RecordingFinalizationResult,
  RecordingIntegrity,
  RecordingJourneyOutcome,
  RecordingPreflightState,
  RecordingSaveState,
  RecordingStopReason,
} from "./live-recording";

export interface RecordingOutboxView {
  hasUnsentRecordingMedia: boolean;
  integrity: RecordingIntegrity;
  pendingPartCount: number;
  recordingDeliveryPhase: RecordingDeliveryPhase;
  saveState: RecordingSaveState;
}

export interface RecordingJourneyState {
  canResetRecoveredRecording: boolean;
  captureEnded: boolean;
  error: string | null;
  finalization: RecordingFinalizationResult | null;
  hasIncompleteRecordingFinalization: boolean;
  isReady: boolean;
  isRecording: boolean;
  journeyOutcome: RecordingJourneyOutcome;
  recordingPreflightState: RecordingPreflightState;
  recordingStopReason: RecordingStopReason;
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
  hasIncompleteRecordingFinalization: false,
  isReady: false,
  isRecording: false,
  journeyOutcome: "none",
  recordingPreflightState: "idle",
  recordingStopReason: null,
  recovered: false,
  stream: null,
};

const initialOutbox: RecordingOutboxView = {
  hasUnsentRecordingMedia: false,
  integrity: "ok",
  pendingPartCount: 0,
  recordingDeliveryPhase: "idle",
  saveState: "healthy",
};

export const useRecordingStore = create<RecordingStore>((set) => ({
  ...initialJourney,
  ...initialOutbox,
  reset: () => set({ ...initialJourney, ...initialOutbox }),
  setJourney: (patch) => set(patch),
  syncOutbox: (view) => set(view),
}));
