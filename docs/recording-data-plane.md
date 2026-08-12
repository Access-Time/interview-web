# Recording data plane

The private recording data plane uses Cloudflare D1 for manifests and a private
Cloudflare R2 bucket for recording objects. Alchemy provisions the bucket and
binds it to the TanStack Start Worker as `RECORDINGS`, alongside `DB`.

R2 has no `r2.dev` or custom public domain configured. Objects remain private
and inaccessible directly; this PoC has no application authentication.

## Local setup

Copy `apps/web/.env.example` to `apps/web/.env`. Do not commit the local `.env`
file. Alchemy also needs `ALCHEMY_PASSWORD` in `packages/infra/.env` to encrypt
secret state.

Alchemy's local runtime supplies the `RECORDINGS` and `DB` bindings.

## Deployment

Keep `ALCHEMY_PASSWORD` available so Alchemy can decrypt
its state. The deployment creates or updates the private R2 bucket and Worker
bindings; it does not expose an R2 public domain.

## Tracer bullet

Recording control uses public oRPC procedures (`recording.create` and
`recording.getManifest`) backed by the Drizzle manifest helpers. Binary parts use
an unauthenticated raw `PUT` route and stream directly into private R2. R2 keys
are content-addressed and immutable:
`recordings/{encodedSessionId}/segments/{encodedSegmentId}/parts/{sequence}/sha256/{checksum}`.
No substitute authentication is part of this PoC.

The uploader must send an `X-Content-SHA256` header containing the 64-character
hex SHA-256 checksum. D1 `(segmentId, sequence)` uniqueness selects the
authoritative manifest part. Retry compatibility is checked using key, checksum,
and size; a compatible retry may refresh the recorded ETag. The R2 ETag is
recorded separately and is not treated as the content checksum.

The raw upload request never deletes R2 objects. Invalid, conflicting, or
ambiguous requests may leave unreferenced private R2 candidates; this is
deliberate for the no-auth PoC and requires later lifecycle/operator cleanup.

Local and disposable remote Worker verification cover session creation,
immutable upload retries, conflicts, and manifest retrieval against D1 and
private R2. The disposable remote resources were removed afterward.

## Deferred prerequisite

Workers Container asynchronous finalization requires separate Cloudflare
account enablement. That prerequisite is intentionally deferred until the
recording finalization behavior exists; this setup does not provision or enable
Containers.
