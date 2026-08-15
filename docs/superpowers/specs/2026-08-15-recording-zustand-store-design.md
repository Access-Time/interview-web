# Recording Zustand store

**Date:** 2026-08-15

## Decision

Use Zustand for the candidate journey machine and outbox *view*. Keep the
IndexedDB + upload worker as a plain module. Keep oRPC + TanStack Query for
server reads/writes. MediaRecorder stays outside the store.

## Store owns

- Journey: `isReady`, `isRecording`, `captureEnded`, `error`, `journeyOutcome`,
  `recovered`, `canResetRecoveredRecording`, `finalization`, `stream`
- Outbox view: `saveState`, `integrity`, `pendingPartCount`

## Worker still owns

- Pending part `Map` including `Blob`s
- IndexedDB hydrate / flush / recover / discard
- PUT retries

The worker calls `syncOutbox({ saveState, integrity, pendingPartCount })` when
that view changes. It does not live inside Zustand persist.

## Hook

`useLiveRecording` subscribes with selectors and runs device + outbox effects.
It is not the source of truth for journey or outbox view.
