# Better T Stack bootstrap

## Scope

Bootstrap the application at this repository root. Preserve `CONTEXT.md` and
the existing research documents. Do not implement recording-session behavior.

## Stack

- TanStack Start with a self backend on Cloudflare Workers
- oRPC, Drizzle, Cloudflare D1/SQLite
- pnpm, Husky, Turborepo, Ultracite, and the todo example
- Cloudflare web deployment configuration

Cloudflare D1/SQLite is canonical. The parent specification's explicit stack
decision overrides the bootstrap ticket's conflicting Supabase/PostgreSQL text.

## Bootstrap procedure

1. Run Better T Stack against `.` with `--directory-conflict merge` and
   `--no-install --dry-run` to prove it will not create a nested application or
   overwrite the planning artifacts.
2. Review the dry-run output, then run the same generator without `--dry-run`.
3. Install dependencies with pnpm.

## Verification seams

This ticket creates generated configuration rather than recording behavior, so
the agreed seams are command-level: generator dry-run, generated typecheck and
tooling checks, and a local oRPC endpoint. No custom recording tests belong in
this ticket.

## Boundaries

Cloudflare account credentials and deployment provisioning are out of scope for
local bootstrap verification. Generated Cloudflare configuration is required;
deploying it is not.
