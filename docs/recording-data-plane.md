# Recording data plane

The private recording data plane uses Cloudflare D1 for manifests and a private
Cloudflare R2 bucket for recording objects. Alchemy provisions the bucket and
binds it to the TanStack Start Worker as `RECORDINGS`, alongside `DB`.

R2 has no `r2.dev` or custom public domain configured. Objects are intended to
be accessed only through authenticated operator infrastructure.

## Local setup

Copy `apps/web/.env.example` to `apps/web/.env`, then set `OPERATOR_SECRET` to
a locally generated value. Do not commit either the value or the local `.env`
file. Alchemy also needs `ALCHEMY_PASSWORD` in `packages/infra/.env` to encrypt
secret state.

Generate a value, for example:

```sh
openssl rand -hex 32
```

Alchemy's local runtime supplies the `RECORDINGS` and `DB` bindings. The
operator secret is wrapped with `alchemy.secret` and is never stored as a
literal in source.

## Deployment

Set `OPERATOR_SECRET` in the deployment environment before running the existing
infra deploy command. Keep `ALCHEMY_PASSWORD` available so Alchemy can decrypt
its state. The deployment creates or updates the private R2 bucket and Worker
bindings; it does not expose an R2 public domain.

## Tracer bullet

Recording control uses authenticated oRPC procedures (`recording.create` and
`recording.getManifest`) backed by the Drizzle manifest helpers. Binary parts use
an authenticated raw `PUT` route and stream directly into R2; the durable object
key is derived from session, segment, and sequence.

The uploader must send an `X-Content-SHA256` header containing the 64-character
hex SHA-256 checksum. It is stored in R2 and used to make retries immutable;
the R2 ETag is recorded separately and is not treated as the content checksum.
Authentication is a temporary operator bearer secret and is not a candidate
authentication design.

This local runtime remains dependency-skew blocked; no live deployment
verification is claimed.

## Deferred prerequisite

Workers Container asynchronous finalization requires separate Cloudflare
account enablement. That prerequisite is intentionally deferred until the
recording finalization behavior exists; this setup does not provision or enable
Containers.
