# Effect-Native Finalizer Design

**Date:** 2026-08-17  
**Status:** Approved

## Goal

Make recording finalization Effect-native in both runtimes that already own
it: the Cloudflare finalizer Worker and the Node ffmpeg container. Typed
failures, scoped cleanup, and test layers replace swallowed `put`/`ffmpeg`
errors and ad-hoc `try/catch` control flow. The HTTP job protocol and
Cloudflare Queue remain the external contract.

This is the first Effect adoption in the repo. It does not rewrite the browser
recorder or `@interview-web/db`.

## Non-goals

- No browser/`useLiveRecording` Effect rewrite.
- No Drizzle/`@interview-web/db` rewrite. D1 helpers stay Promise functions
  behind a `FinalizerDb` adapter.
- No Effect Cluster, Workflow, or a second durable bus. Cloudflare Queue stays
  authoritative for redelivery.
- No new public routes, auth, or playback UI.
- No change to MediaRecorder timeslice (`5000` ms) or the part-upload API.
- No one-shot mega-PR. Destination is the full service architecture; delivery
  is three stacked PRs.

## Evidence this work sits on

Two production-shaped local failures on `recording/e2e-coverage`:

1. **Publication not proven.** `processFinalization` streamed the container
   body into R2 and treated `checksums.sha256` as `ArrayBuffer` only. Local
   Miniflare returns hex strings; `put` errors were swallowed. Queue dropped
   the job after six retries. Fixed in `4bd099f` by buffering the output,
   verifying size/checksum, and accepting hex or binary checksums.
2. **Five-second playback of a longer take.** Timeslice blobs are one WebM
   bitstream; only part 0 has an EBML header. Concat-demuxing them keeps one
   timeslice. Session `48b02b80-7b70-4569-bcab-2fcc4eb57067` has five parts
   (~17 MB) and a published object of 398 478 bytes / **5.021 s**. Byte-concat
   of those parts is the full take. Fixed in `da20e30` by assembling parts
   inside a segment before remux. A still-running old container can publish
   the 5 s file after the image is rebuilt; restart the container and
   re-finalize to repair existing `ready` rows.

Those media rules stay **pure functions**. Effect owns control flow, resources,
and errors around them.

## Architecture

One package, two runtimes, shared domain with no `node:` or Cloudflare imports.

```
packages/finalizer/src/
  domain/     Schema, tagged errors, pure media rules
  worker/     Cloudflare fetch/queue/scheduled + Worker layers
  server/     Node HTTP + JobStore + Ffmpeg
```

- Worker entry stays the Alchemy `entrypoint` (today `src/worker.ts`, moved
  under `src/worker/`).
- Node entry is `src/server/main.ts`. Docker **esbuild-bundles** it to
  `server.js`. Image still `CMD ["node", "server.js"]`.
- `@effect/platform-node` is a server-only dependency. The Worker bundle must
  not import it.
- Bindings (`DB`, `RECORDINGS`, `FINALIZER`, `FINALIZATION_QUEUE`) enter
  through `Context.Tag` layers. That is the documented exception to
  `Effect.Service` for runtime-injected infrastructure.

## Domain

### Brands and schemas

- `SessionId` — branded string, length 1–128 (dispatch already enforces this).
- `Sha256Hex` — `/^[a-f0-9]{64}$/i`, stored lowercase.
- `FinalizerPart`, `FinalizerManifest`, `FinalizePlan` — `Schema.Struct`
  equivalents of today's `pure.ts` types.
- `PublishedObject` — `{ objectKey, mediaType, byteSize, checksum }`.

`validateManifest` / `validateFinalizePlan` become `Schema.decode` (or
`Schema.decodeUnknown`) and fail with the tagged errors below. Checksum
normalization (`string | ArrayBuffer | ArrayBufferView` → lowercase hex)
stays a pure helper; R2/HTTP boundaries keep `T | null`, domain code uses
`Option` only inside Effect programs.

### Tagged errors

Every distinct failure has its own `Schema.TaggedError`. No `Effect.Effect<A, Error>`.

**Terminal** (claim `fail`, do not retry in-attempt):

| Tag | When |
|---|---|
| `InvalidManifest` | segment count/shape |
| `IncompleteManifest` | missing parts or index gaps |
| `InvalidPart` | size/checksum/key |
| `InvalidFinalizePlan` | plan ≠ manifest |
| `MissingOrCorruptPart` | absent R2 body, size mismatch, or checksum mismatch after a successful get |
| `InvalidContainerOutput` | output headers/body |
| `ContainerRejected` | container 400/413/415/422 |
| `FfmpegFailed` | non-zero ffmpeg |
| `NoMediaStream` | ffprobe finds no audio/video |
| `JobNotOpen` | part/finalize after seal |
| `PartsPlanMismatch` | uploaded keys ≠ plan |
| `PartAlreadyDiffers` | idempotent PUT conflict |

**Transient** (claim `release`, in-attempt `Schedule` and/or queue retry):

| Tag | When |
|---|---|
| `LeaseLost` | claim/renew lost |
| `OutputSizeMismatch` | container body ≠ `Content-Length` |
| `OutputChecksumMismatch` | container body ≠ `x-content-sha256` |
| `OutputPublicationNotProven` | `put`/`head` cannot prove exact object |
| `OutputPublicationMetadataMismatch` | put returned object that does not match |
| `ContainerUnavailable` | container 5xx / network |
| `QueueSendFailed` | dispatch `send` throws |
| `RecordingsUnavailable` | R2 `get`/`head`/`put`/`delete` transport failure |
| `FinalizerDbUnavailable` | D1 adapter transport failure |

`ContainerRejected` vs `ContainerUnavailable` is decided by the existing
status set `[400, 413, 415, 422]`.

## Services

All business methods are `Effect.fn("Service.method")`. Dependencies are
declared on the service (`dependencies: [...]`), not at call sites. Root
composition is `Layer.mergeAll` / `Layer.provideMerge`.

### Worker

```ts
FinalizerDb
  claim(sessionId): Effect<Option<ClaimedJob>, FinalizerDbUnavailable>
  complete(input): Effect<boolean, FinalizerDbUnavailable>
  fail(input): Effect<boolean, FinalizerDbUnavailable>
  release(input): Effect<boolean, FinalizerDbUnavailable>
  renew(input): Effect<boolean, LeaseLost | FinalizerDbUnavailable>
  ready(sessionId): Effect<Option<PublishedObject>, FinalizerDbUnavailable>
  listDue(now, limit): Effect<ReadonlyArray<SessionId>, FinalizerDbUnavailable>

Recordings
  get(key): Effect<PartObject, MissingOrCorruptPart | RecordingsUnavailable>
  put(key, bytes, opts): Effect<Option<PublishedMeta>, OutputPublicationNotProven | RecordingsUnavailable>
  head(key): Effect<Option<PublishedMeta>, RecordingsUnavailable>
  delete(key): Effect<void, RecordingsUnavailable>

ContainerClient
  putPart(job, segment, sequence, body, checksum): Effect<void, ContainerRejected | ContainerUnavailable>
  finalize(job, plan): Effect<void, ContainerRejected | ContainerUnavailable>
  getOutput(job): Effect<ContainerOutput, InvalidContainerOutput | ContainerUnavailable>
  deleteJob(job): Effect<void, never>  // best-effort in finalizer

FinalizationQueue
  send(sessionId): Effect<void, QueueSendFailed>
```

`processFinalization` is `Effect.fn("processFinalization")`. It does not take
a `dbFns` bag. Tests provide `FinalizerDb.Default` test layers.

### Node container

```ts
JobStore
  beginSeal(job): Effect<void, JobNotOpen>
  reopen(job): Effect<void>
  putPart(job, segment, sequence, bytes, checksum): Effect<void, JobNotOpen | PartAlreadyDiffers | …>
  assembleSegment(job, segment, partIndexes): Effect<AssembledFile, PartsPlanMismatch>
  outputFile(job): Effect<OutputFile, InvalidContainerOutput>
  deleteJob(job): Effect<void, never>

Ffmpeg
  remux(input, output, mediaType): Effect<void, FfmpegFailed>
  probe(file): Effect<void, NoMediaStream | FfmpegFailed>
```

`finalizeJob` is `Effect.fn("finalizeJob")`: validate plan → assemble each
segment (byte-concat when `partIndexes.length > 1`) → `Ffmpeg.remux` →
optional concat-demux of **remuxed segment files only** → probe → store
output metadata.

HTTP is `@effect/platform` (`HttpRouter` / `HttpServer`) on the **existing**
routes:

- `GET /health` → 204
- `PUT /jobs/:id/parts/:segment/:sequence`
- `POST /jobs/:id/finalize`
- `GET /jobs/:id/output`
- `DELETE /jobs/:id`

No new paths. Local miniflare still requires absolute URLs; the Worker
continues to resolve `/jobs/...` against `http://container`.

## Data flow

Unchanged externally:

1. Web persists `queued`, then `POST /internal/finalizations` `{ sessionId }`.
2. Worker `fetch` Schema-decodes the body, `FinalizationQueue.send`, returns
   `202`. Decode failure is `400`; send failure is `QueueSendFailed` → `503`.
3. Queue consumer runs `processFinalization`.
4. `claim` → `Scope` with heartbeat `Schedule.fixed("60 seconds")` via
   `Effect.forkScoped` → for each part `Recordings.get` then
   `ContainerClient.putPart` → `ContainerClient.finalize` → `getOutput` →
   verify size/sha256 → `Recordings.put` → `isExactPublishedObject` on put
   result or `head` → `complete`.
5. Scope close always interrupts the heartbeat and `deleteJob` (best-effort).
6. `scheduled` still `listDue` → `queue.send`. Batch size stays 20.

Cloudflare Queue (`maxRetries: 5`, `batchSize: 1`) remains the durable retry
bus. Effect `Schedule` retries **inside one attempt** only: container 5xx and
publication proof, capped at 3 retries with exponential delay starting at
`200 millis`. Terminal errors never retry in-attempt. This must not multiply
into “3 × 6” silent loops: in-attempt retries are only for errors that are
safe to repeat without a new claim.

`handleQueueMessage` maps:

- success → `ack`
- `Terminal*` → `fail` then `ack` (do not redeliver a bad manifest)
- `Transient*` after in-attempt retries → `release` and **rethrow** so the
  Queue redelivers
- defects → rethrow

## Resource and retry rules

- Lease heartbeat lives in the same `Scope` as the attempt. Losing renew
  fails `LeaseLost` and aborts in-flight container fetches via `AbortSignal`
  / fiber interrupt.
- Temp job directories are `JobStore` scoped resources. `deleteJob` runs in
  `addFinalizer`.
- `Recordings.delete` of an unpublished output stays in the transient
  failure path when the ready row does not already match the candidate.
- `RecordingsUnavailable` and `FinalizerDbUnavailable` are transient: `release`
  (if claimed) and rethrow for Queue redelivery. They are not in the in-attempt
  `Schedule`.
- Do not `try/catch` inside `Effect.gen` for Effect failures. Wrap D1, R2,
  `fetch`, and `spawn` with `Effect.tryPromise` at the adapter edge only.
- Do not `console.log`. Use `Effect.log` with `{ sessionId, attempt, reason }`.
- `Option` internally; `T | null` at R2, HTTP, and D1 row boundaries.

## Testing

- `@effect/vitest` for new suites. Existing Vitest protocol tests migrate
  onto the Effect HTTP app; they keep the same assertions (201/200/409/422,
  byte-concat of `"a"`+`"b"` → `"ab"`, no concat-demux of timeslice parts).
- Test layers: in-memory `JobStore`, scripted `Ffmpeg` (same `run` hook
  today’s harness uses), fake `Recordings`, fake `FinalizerDb`.
- Worker publication tests stay: hex-string `head` proves; `put` returning
  null + matching `head` completes; stream-vs-buffer is gone because the
  worker always puts `Uint8Array`.
- Optional local-only test (skipped in CI unless `FINALIZER_REAL_FFMPEG=1`):
  five real timeslice parts → remux duration ≥ 18 s. Not required to merge.
- `pnpm --filter @interview-web/finalizer test` and `check-types` stay green.
- Add `@effect/language-service` to the finalizer `tsconfig` plugins.

## Docker and dependencies

- `effect`, `@effect/platform`, `@effect/vitest`, `@effect/language-service`
  on the finalizer package.
- `@effect/platform-node` is a **server-only** dependency, imported only from
  `src/server/**`.
- Dockerfile: build stage runs esbuild on `src/server/main.ts` → `server.js`,
  runtime stage is still `node:22-bookworm-slim` + ffmpeg + `server.js`.
- Alchemy `entrypoint` points at the Worker file. `sourceMap: false` stays
  (existing watch-loop avoidance).

## PR stack

### PR 1 — Domain

Add Effect deps and language service. Move `pure.ts` to `src/domain/`. Replace
thrown `TerminalFinalizationError` strings with tagged errors + Schema
decode. Keep worker/server behavior identical by adapting at the edge.
Tests for Schema decode and `isExactPublishedObject`.

### PR 2 — Worker

Introduce `FinalizerDb`, `Recordings`, `ContainerClient`, `FinalizationQueue`
layers. Rewrite `processFinalization`, `dispatchFinalizationRequest`,
`handleQueueMessage`, and `scheduled` as Effect. Preserve queue/lease
semantics above. Publication proof tests run on the Effect program.

### PR 3 — Server

Port `server.js` to `src/server/` TypeScript. `JobStore` + `Ffmpeg` +
`@effect/platform` HTTP. Docker esbuild. Protocol tests hit the Effect app.
Assemble/remux behavior from `da20e30` is preserved, now behind `JobStore`.

Each PR is independently testable and deployable. PR 3 is the first that
requires a container image rebuild.

## Constraints (verbatim)

- HTTP job protocol is unchanged.
- Only the finalizer Worker writes `FINALIZATION_QUEUE`.
- Timeslice parts inside one segment are byte-concatenated; remuxed segments
  may concat-demux.
- `checksums.sha256` may be hex string or binary; proof uses
  `normalizeSha256Checksum`.
- Node 22.22.2 for local Worker tooling; container base is `node:22`.
- Ultracite/Biome on all new TS. No `console.log` in Effect programs.
- Do not wrap pure media helpers in `Effect.try`.
