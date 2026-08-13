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

### Turbo strict env mode (important, non-obvious)
- Turborepo 2.x defaults to **strict** env mode, which strips undeclared env vars (including
  `CLOUDFLARE_API_TOKEN`) from task processes. Because of this, `pnpm dev` (which is
  `turbo run dev -F @interview-web/infra`) fails with Alchemy's `No credentials found ...
  set either CLOUDFLARE_API_TOKEN or CLOUDFLARE_API_KEY` even when the token is exported.
- The environment handles this by exporting `TURBO_ENV_MODE=loose` from `~/.bashrc` (captured
  in the snapshot), so login/tmux shells forward the token to turbo tasks. If you invoke
  `pnpm dev` from a non-login shell and hit the credentials error, prefix it with
  `TURBO_ENV_MODE=loose` (or run `alchemy dev` directly from `packages/infra`).

### Docker (required for `pnpm dev`, non-obvious)
- `packages/infra/alchemy.run.ts` declares a Cloudflare **Container** (`recording-finalizer-container`,
  an ffmpeg image built from `packages/finalizer/Dockerfile`). During `alchemy dev`, Alchemy runs
  `docker build`, so `pnpm dev` **requires a running Docker daemon** — without it dev crashes with
  `spawn docker ENOENT`.
- The environment installs `docker.io` + `fuse-overlayfs` and starts `dockerd` on boot (fuse-overlayfs
  storage driver, needed for nested VMs) via the environment `start` script. If `docker info` fails,
  run `sudo dockerd >/tmp/dockerd.log 2>&1 &` and `sudo chmod 666 /var/run/docker.sock`.

### Local Alchemy dev state (troubleshooting)
- `alchemy dev` keeps local resource state under gitignored `.alchemy/` dirs. If a dev run is
  interrupted mid-provision, a later run may fail on the `[updating] web` path with a spurious
  `No credentials found`. Clearing state fixes it:
  `rm -rf .alchemy apps/web/.alchemy packages/infra/.alchemy ~/.alchemy` then `pnpm dev`.

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
  a pre-existing lint finding in `packages/env/env.d.ts`; this is not an environment issue.


# Ultracite Code Standards

This project uses **Ultracite**, a zero-config preset that enforces strict code quality standards through automated formatting and linting.

## Quick Reference

- **Format code**: `pnpm dlx ultracite fix`
- **Check for issues**: `pnpm dlx ultracite check`
- **Diagnose setup**: `pnpm dlx ultracite doctor`

Biome (the underlying engine) provides robust linting and formatting. Most issues are automatically fixable.

---

## Core Principles

Write code that is **accessible, performant, type-safe, and maintainable**. Focus on clarity and explicit intent over brevity.

### Type Safety & Explicitness

- Use explicit types for function parameters and return values when they enhance clarity
- Prefer `unknown` over `any` when the type is genuinely unknown
- Use const assertions (`as const`) for immutable values and literal types
- Leverage TypeScript's type narrowing instead of type assertions
- Use meaningful variable names instead of magic numbers - extract constants with descriptive names

### Modern JavaScript/TypeScript

- Use arrow functions for callbacks and short functions
- Prefer `for...of` loops over `.forEach()` and indexed `for` loops
- Use optional chaining (`?.`) and nullish coalescing (`??`) for safer property access
- Prefer template literals over string concatenation
- Use destructuring for object and array assignments
- Use `const` by default, `let` only when reassignment is needed, never `var`

### Async & Promises

- Always `await` promises in async functions - don't forget to use the return value
- Use `async/await` syntax instead of promise chains for better readability
- Handle errors appropriately in async code with try-catch blocks
- Don't use async functions as Promise executors

### React & JSX

- Use function components over class components
- Call hooks at the top level only, never conditionally
- Specify all dependencies in hook dependency arrays correctly
- Use the `key` prop for elements in iterables (prefer unique IDs over array indices)
- Nest children between opening and closing tags instead of passing as props
- Don't define components inside other components
- Use semantic HTML and ARIA attributes for accessibility:
  - Provide meaningful alt text for images
  - Use proper heading hierarchy
  - Add labels for form inputs
  - Include keyboard event handlers alongside mouse events
  - Use semantic elements (`<button>`, `<nav>`, etc.) instead of divs with roles

### Error Handling & Debugging

- Remove `console.log`, `debugger`, and `alert` statements from production code
- Throw `Error` objects with descriptive messages, not strings or other values
- Use `try-catch` blocks meaningfully - don't catch errors just to rethrow them
- Prefer early returns over nested conditionals for error cases

### Code Organization

- Keep functions focused and under reasonable cognitive complexity limits
- Extract complex conditions into well-named boolean variables
- Use early returns to reduce nesting
- Prefer simple conditionals over nested ternary operators
- Group related code together and separate concerns

### Security

- Add `rel="noopener"` when using `target="_blank"` on links
- Avoid `dangerouslySetInnerHTML` unless absolutely necessary
- Don't use `eval()` or assign directly to `document.cookie`
- Validate and sanitize user input

### Performance

- Avoid spread syntax in accumulators within loops
- Use top-level regex literals instead of creating them in loops
- Prefer specific imports over namespace imports
- Avoid barrel files (index files that re-export everything)
- Use proper image components (e.g., Next.js `<Image>`) over `<img>` tags

### Framework-Specific Guidance

**Next.js:**
- Use Next.js `<Image>` component for images
- Use `next/head` or App Router metadata API for head elements
- Use Server Components for async data fetching instead of async Client Components

**React 19+:**
- Use ref as a prop instead of `React.forwardRef`

**Solid/Svelte/Vue/Qwik:**
- Use `class` and `for` attributes (not `className` or `htmlFor`)

---

## Testing

- Write assertions inside `it()` or `test()` blocks
- Avoid done callbacks in async tests - use async/await instead
- Don't use `.only` or `.skip` in committed code
- Keep test suites reasonably flat - avoid excessive `describe` nesting

## When Biome Can't Help

Biome's linter will catch most issues automatically. Focus your attention on:

1. **Business logic correctness** - Biome can't validate your algorithms
2. **Meaningful naming** - Use descriptive names for functions, variables, and types
3. **Architecture decisions** - Component structure, data flow, and API design
4. **Edge cases** - Handle boundary conditions and error states
5. **User experience** - Accessibility, performance, and usability considerations
6. **Documentation** - Add comments for complex logic, but prefer self-documenting code

---

Most formatting and common issues are automatically fixed by Biome. Run `pnpm dlx ultracite fix` before committing to ensure compliance.
