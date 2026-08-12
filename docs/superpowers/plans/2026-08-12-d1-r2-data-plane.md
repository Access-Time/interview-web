# D1 and R2 data-plane implementation plan

> **For agentic workers:** Use the repository's normal implementation workflow. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the recording data plane around durable recording-session manifests in D1 and ordered binary upload parts in private R2.

**Architecture:** oRPC creates and reads recording-session manifests through Drizzle. A raw TanStack route accepts each ordered binary part, streams it to private R2, and acknowledges it only after a typed Drizzle-backed D1 batch write records the upload part. The manifest hierarchy is session → ordered segments → ordered upload parts. Reloads create new segments; finalization is not part of this work.

**Tech Stack:** TanStack Start, Cloudflare Workers, oRPC, D1, Drizzle, private R2, and the existing test tooling.

## Global constraints

- Keep D1/SQLite as the manifest store and use Drizzle for all manifest reads and writes.
- Keep R2 private; do not configure an `r2.dev` or custom public domain.
- No application authentication is part of this no-auth PoC. Keep R2 private so objects remain inaccessible directly; do not add substitute auth.
- The two TDD seams are the public oRPC router contract and the raw upload handler.
- Delete the current generic probe route, its probe schema, and its tests; do not preserve a compatibility path.
- Containers are deferred.
- Do not add speculative finalization, browser capture, playback, or reviewer features.

---

### Task 1: Replace the probe schema with the recording manifest schema

**Files:**
- Delete: the current generic probe schema and its migration artifacts, if any
- Create/modify: the Drizzle schema and exports under `packages/db/src/`
- No schema migration is needed for this clean PoC.

**Interfaces:**
- `recordingSession` is the root manifest with durable identity and lifecycle timestamps.
- `recordingSegment` belongs to one session and has a unique ordering within that session.
- `recordingUploadPart` belongs to one segment, has a unique ordering within that segment, and stores the acknowledged private R2 object key plus upload metadata needed for recovery.
- Foreign keys and `(sessionId, sequence)` / `(segmentId, sequence)` uniqueness enforce the hierarchy and ordering.

- [ ] Write the schema and types for session, segment, and ordered upload part.
- [ ] Remove the generic probe table/schema exports; keep the existing schema and migration state consistent.

### Task 2: Public oRPC manifest contract

**Files:**
- Create/modify: the public oRPC router and its schemas under the web/server package
- Create/modify: focused router-contract tests
- Modify: shared database wiring only where required to provide the Drizzle D1 database

**Interfaces:**
- The router exposes the approved operations to create a recording session and read its manifest.
- Inputs and outputs are typed; reads return the session with ordered segments and ordered acknowledged upload parts.
- Database writes and reads go through Drizzle rather than direct ad hoc SQL.
- The oRPC procedures are public for this no-auth PoC; injected recording bindings remain required.

- [ ] Start with failing tests against the public oRPC router contract.
- [ ] Implement session creation and manifest reads with Drizzle and deterministic ordering.
- [ ] Return typed not-found and validation errors without adding finalization behavior.

### Task 3: Raw ordered-part upload handler

**Files:**
- Create/modify: the raw TanStack upload route
- Create/modify: focused raw upload-handler tests
- Modify: Worker/R2 binding and authentication wiring only where required

**Interfaces:**
- The handler accepts an unauthenticated upload for an existing session and segment, validates the part ordering and request metadata, and streams the request body directly to a private R2 key.
- It acknowledges success only after a typed Drizzle-backed D1 batch write records the ordered upload part.
- Duplicate or conflicting part acknowledgements are rejected safely; failed manifest acknowledgement does not report success.
- The handler is independently testable with injected R2 and Drizzle seams.

- [ ] Start with failing tests for public access, streaming the raw binary body, ordering, typed transaction acknowledgement, and failure responses.
- [ ] Implement the minimum handler needed to pass those tests.
- [ ] Treat R2 keys as content-addressed and immutable: `recordings/{encodedSessionId}/segments/{encodedSegmentId}/parts/{sequence}/sha256/{checksum}`.
- [ ] Use D1 `(segmentId, sequence)` uniqueness as the authoritative manifest-part choice; check retry compatibility by key, checksum, and size, allowing a compatible retry to refresh ETag.
- [ ] Never delete objects in the raw upload request. Invalid, conflicting, or ambiguous requests may leave unreferenced private R2 candidates for later lifecycle/operator cleanup; do not claim atomicity across R2 and D1.

### Task 4: Remove probe implementation and defer Containers

**Files:**
- Delete: current generic probe route and probe tests
- Remove: probe-only bindings, commands, and documentation references
- Review: Container-related files without implementing Container support

- [ ] Confirm no route, schema, test, or task still targets the generic data-plane probe.
- [ ] Confirm no Container provisioning or runtime code is added; record Containers as deferred until finalization requirements exist.
- [ ] Keep this plan limited to manifest creation/reads and ordered raw-part persistence.

### Task 5: Validation handoff

- [ ] Hand validation to the orchestrator; this plan does not prescribe or run additional validation commands.
- [ ] Do not commit as part of this documentation update.
