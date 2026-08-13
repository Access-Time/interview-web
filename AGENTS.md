# AGENTS.md

## Cursor Cloud specific instructions

This is a pnpm + Turborepo monorepo (`interview-web`). The single deployable app is
`apps/web` — a TanStack Start app (React SSR frontend + oRPC/API backend routes) that runs
as a Cloudflare Worker, orchestrated locally by **Alchemy** (`packages/infra/alchemy.run.ts`),
backed by Cloudflare D1 (SQLite) and a private R2 bucket. Standard scripts live in the root
`package.json` and `README.md`; prefer those instead of re-deriving commands.

### Node version (important, non-obvious)
- Use **Node 22.22.2** (via nvm). The pinned `/exec-daemon/node` is v22.14.0, which is too old:
  `@cloudflare/vite-plugin` imports `registerHooks` from `node:module` (added in Node 22.15+),
  so `pnpm dev` crashes with `does not provide an export named 'registerHooks'` on the old node.
- This is handled automatically: `~/.bashrc` prepends the nvm 22.22.2 bin ahead of
  `/exec-daemon` so login shells (including tmux dev sessions) resolve the correct `node`.
  If you ever see the `registerHooks` error, run `nvm use 22.22.2` (or start a login shell) first.
- `pnpm install` itself works on either node version.

### Environment / secrets (required to run the app)
- `apps/web/.env` sets `CORS_ORIGIN=http://localhost:3001` (copied from `.env.example`).
- `packages/infra/.env` sets `ALCHEMY_PASSWORD` (encrypts Alchemy's local secret state; any
  stable value works for local dev — a default is provided). These `.env` files are gitignored.
- `alchemy dev` (i.e. `pnpm dev`) provisions a Cloudflare Worker and therefore **requires real
  Cloudflare credentials**: set `CLOUDFLARE_API_TOKEN` (provided via Cursor Secrets → injected as
  an env var). There is no offline/local-only mode; `dev:bare` (plain `vite dev`) renders the UI
  but leaves the `DB`/`RECORDINGS` bindings undefined, so DB/R2 features won't work.

### Running / lint / test / build
- Dev server: `pnpm dev` → serves http://localhost:3001 (Alchemy wires local D1 + R2 bindings).
  Run it in a long-lived tmux/login shell; it is persistent and must not be treated as a
  one-shot command.
- Tests: `pnpm test` — `node --test` with mocked storage/db (no live services needed).
- Build: `pnpm build`. Type-check: `pnpm check-types`.
- Lint/format: `pnpm check` / `pnpm fix` (Ultracite/Biome). Note: the repo currently has
  pre-existing lint findings in `apps/web/src/routes/todos.tsx` and `packages/env/env.d.ts`;
  these are not environment issues.
