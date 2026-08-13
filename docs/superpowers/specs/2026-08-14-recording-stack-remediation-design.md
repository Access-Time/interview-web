# Recording Stack Remediation Design

**Date:** 2026-08-14

## Goal

Finish the candidate-recording proof of concept without changing its scope:

- capture survives transient upload/finalization problems;
- camera and microphone stop as soon as capture ends;
- candidates receive truthful, accessible status and recovery guidance;
- finalization works through the same durable path locally and in Cloudflare;
- all automated tests use Vitest or Playwright only.

The work remains split across the existing stack: PR #6 owns the browser journey and test-runner foundation; PR #8 owns private finalizer dispatch and finalizer reliability after rebasing onto PR #6.

## Non-goals

- No recording playback, elective re-recording, public sharing, accounts, or operator workflow.
- No public finalizer endpoint.
- No user-managed token or shared secret.
- No direct finalizer execution from the web worker; finalization remains queue-driven.

## Architecture

### Private finalizer dispatch

The finalizer Worker is created before the web Worker and is explicitly private: it has no URL, routes, domains, or preview subdomain. Alchemy binds it to the web Worker as a Cloudflare Service Binding.

After the API marks a recording as `queued`, web invokes the finalizer through the binding's default `fetch` interface. The finalizer accepts only its narrow internal dispatch request, validates the method, path, body, and bounded session ID, then waits for its own `FINALIZATION_QUEUE.send({ sessionId })` call to succeed.

This yields one invariant in every environment:

> Only the finalizer Worker writes to the finalization queue; web dispatches through its private Service Binding.

Production therefore uses `web service binding -> finalizer -> Cloudflare Queue`, and local development uses the local service-binding registry -> finalizer Miniflare process -> that process's queue consumer. Existing durable D1 claim/release behavior, queue retries, and scheduled reconciliation remain the duplicate/loss backstops. The finalizer passes its own `env.DB` explicitly to database construction.

The private handler re-enqueues only. It does not call `processFinalization` directly, so queue retry and redelivery semantics remain authoritative. Service-binding failure or queue-send failure is returned as a failure; the API must not report a successful queued submission when dispatch failed.

### Candidate recording lifecycle

`useLiveRecording` gains one idempotent capture-ending completion path used by manual stop, recorder failure, and fatal outbox/save failure.

1. Mark capture as ended and immediately stop all stream tracks.
2. Clear the local stream and ready state so preview and media permissions are no longer represented as active.
3. Flush the terminal recorder chunk, persist/seal the session, and dispatch finalization when that work remains valid.
4. Preserve the physical `captureEnded` fact even if subsequent save or finalization work fails.

The state contract distinguishes explicit failure dispositions rather than matching error text:

- **automatic retry:** data is durable and retrying continues;
- **manual retry:** capture is over, data is durable, and the candidate may redispatch finalization;
- **terminal restart:** recording stopped because safe persistence cannot continue; a new setup is allowed only if a reset is genuinely supported.

Remote recovery treats a session as missing only on the typed oRPC `NOT_FOUND` outcome. Transport, deployment, or other lookup failures do not delete local recovery data or reset the candidate.

### Candidate-facing states

The existing Kumo-based journey panel remains the sole UI surface. It keeps semantic buttons, existing focus behavior, and 48px controls. Candidate wording and behavior are:

| State | Candidate message | Action |
| --- | --- | --- |
| Recording | “Keep this screen open and stay in this browser while you record.” | Stop recording |
| Saving delayed | “Keep this screen open; we’ll keep trying.” Offline: “Saving will resume when you reconnect.” | None |
| Submitting | “Your camera and microphone are off. Keep this screen open until submission is complete.” | None |
| Retryable submission failure | “Your recording is still here. Check your connection, then try again.” | Try submitting again |
| Terminal capture/save failure | “Your camera and microphone are off. We couldn’t save this recording safely.” | Start a new recording, only when reset is supported |
| Missing recovered recording | “We couldn’t find your unfinished recording. It can’t be continued.” | Set up a new recording, followed by the normal Start recording confirmation |
| Complete | Existing completion wording | None |

Normal completion and normal stop never expose re-recording. Missing-recovery restart is a recovery-only exception, not a new candidate feature.

The journey adds one persistent polite `role="status"` region for asynchronous save, offline, and retry updates. Terminal blocking failures remain alerts and focus their heading on entry. Each message is announced once; state-transition copy is not duplicated between live regions. The recording state includes concise foreground/browser guidance for mobile candidates.

## Test strategy

### Runner migration

The repository moves all real automated suites from `node:test`/`tsx --test` to Vitest:

- `apps/web`: Vitest with jsdom and the existing Vite aliases/shims;
- `packages/finalizer`: Vitest in the Node environment for server and worker tests;
- `packages/db`: remove its stale `node --test` script because it has no test files.

The root Turbo `test` command remains the orchestrator. `tsx` is removed from the web test toolchain once no longer used. No new runner is introduced.

Playwright is added only under `apps/web` as an explicit `test:e2e` command, separate from the unit-test Turbo task. It uses browser-side media and API mocking so it can run against the bare Vite app rather than requiring Cloudflare credentials, Docker, or cross-process local queues.

### Required coverage

Vitest covers:

- capture-ending state transitions and immediate track release for manual and fatal stops;
- retry disposition and candidate copy/CTA precedence;
- live-region announcements;
- typed `NOT_FOUND` versus transport failure recovery handling;
- private finalizer-dispatch validation, binding failure, queue-send failure, and finalizer queue handoff.

Playwright covers:

- normal and fatal-stop camera/microphone release;
- delayed-save/retry announcement and retry action;
- mobile foreground guidance;
- typed missing recovered session -> explicit setup/restart -> normal record-start flow;
- a local smoke path from queued recording to ready submission through the private service binding.

## Delivery order

1. On PR #6, migrate test runners and add Playwright foundation, then implement browser lifecycle, recovery, and accessibility fixes with Vitest/Playwright coverage.
2. Verify PR #6 and merge it.
3. Rebase PR #8 onto the completed PR #6.
4. On PR #8, add the private finalizer Service Binding, internal enqueue handler, explicit finalizer DB binding, dispatch-failure propagation, and reliability coverage.
5. Verify both branches using Vitest and Playwright, then re-review against the parent and child Teamwork tickets.

## Acceptance criteria

- Every capture exit stops camera and microphone immediately and clears preview state.
- Candidate notices accurately distinguish retrying, manual retry, and terminal failure.
- Accessibility announcements cover asynchronous status changes without duplicate speech.
- A genuinely missing recovered recording produces an explicit recovery setup path; incidental request failures do not discard recovery.
- The finalizer has no public route and requires no secret because its only dispatcher is a private Cloudflare Service Binding.
- Local and production finalization use the same private-dispatch-to-finalizer-queue topology.
- No automated test uses `node:test`, `node --test`, `tsx --test`, or another test runner; tests use only Vitest and Playwright.
