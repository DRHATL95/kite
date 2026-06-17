# UI Build Reproducibility (pnpm) — Design

- **Date:** 2026-06-17
- **Status:** Approved (pending spec review)
- **Scope:** Frontend (`ui/`) dependency management + the CI frontend-build step. No app-behavior changes.

## Problem

UI builds are not reproducible:

- Six `devDependencies` in `ui/package.json` are pinned to `"latest"`
  (`vite`, `vitest`, `svelte-check`, `typescript`, `@sveltejs/vite-plugin-svelte`,
  `@tsconfig/svelte`), so every CI run re-resolves them — version drift, and two
  nightlies from the same commit aren't guaranteed identical.
- A `ui/package-lock.json` is committed but **CI deletes it** and runs
  `npm install`, because the Windows-generated lockfile won't materialize the
  Linux `rolldown` native binding (vite 8's bundler ships its native binary as a
  platform-gated `optionalDependency`; npm/cli#4828). So the lockfile is not
  authoritative and the build silently depends on whatever npm resolves that day.
- Local node is **v24**; the runner uses **node 20** — an unstated version gap.

## Decision

Migrate the `ui/` package management to **pnpm**, provisioned via **corepack**.
pnpm records all platform variants of native optional deps in a single
`pnpm-lock.yaml`, so the same lockfile resolves correctly on Windows (local) and
Linux (CI) — removing the reason CI nukes the lockfile. CI then installs with
`--frozen-lockfile` for a reproducible, drift-proof build.

## Changes

### 1. Adopt pnpm via corepack
- Add `"packageManager": "pnpm@<x.y.z>"` to `ui/package.json` (exact current
  stable pnpm). Corepack (bundled with node ≥16.9) provisions exactly that pnpm
  version locally and on the runner — nothing to install manually.

### 2. Pin the drifting devDeps
- Replace the six `"latest"` devDeps with their currently-resolved exact
  versions (read from the existing `ui/package-lock.json` before deleting it).
- `dependencies` keep their existing caret ranges; the lockfile pins the full
  resolved tree regardless, so this is the minimal change that removes the drift.

### 3. Switch the lockfile
- Generate `ui/pnpm-lock.yaml` (committed).
- Delete `ui/package-lock.json` (no longer used).
- The pnpm lockfile includes the rolldown bindings for both `win32-x64` and
  `linux-x64-gnu`, so one committed lockfile serves both platforms.

### 4. CI uses a frozen install
In `.github/workflows/release.yml`, replace the "Build frontend" step body:

```bash
rm -rf ui/node_modules ui/package-lock.json
npm --prefix ui install --no-audit --no-fund
npm --prefix ui run build
```

with:

```bash
corepack enable
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui build
```

`--frozen-lockfile` fails the build if `package.json` and `pnpm-lock.yaml` are
out of sync — making the lockfile authoritative and the install reproducible.

### 5. Node alignment (soft)
- Add `.nvmrc` containing `20` and `engines.node: ">=20"` in `ui/package.json`,
  documenting the runner's node major so local and CI agree. Not strict-enforced
  (won't block local node 24) — a documented target, not a hard gate.

### 6. Docs sweep
- Update `CLAUDE.md` and `README.md`: every `npm --prefix ui …` →
  `pnpm --dir ui …` (build / run / check / test commands and the
  frontend-rebuild notes). Note corepack: first-time local setup runs
  `corepack enable`.
- Update `docs/RELEASES.md` only if it references the npm frontend step (it
  describes the build conceptually; adjust the one `npm` mention if present).

## What this fixes

- **No drift:** exact-pinned devDeps + a frozen lockfile → byte-identical
  dependency tree on every build.
- **Authoritative lockfile:** CI no longer deletes it; one lockfile works on both
  OSes, so a green build today reproduces tomorrow from the same commit.
- **Pinned toolchain:** corepack pins pnpm; `.nvmrc` documents node.

## Testing / verification

- Local (Windows): `corepack enable && pnpm --dir ui install --frozen-lockfile`
  succeeds; `pnpm --dir ui check` (svelte-check 0/0), `pnpm --dir ui test`
  (vitest green), `pnpm --dir ui build` (writes `ui/dist`).
- `cargo run` still embeds `ui/dist` and launches (build output unchanged).
- CI: a nightly build is green with the new frozen-install step on the Linux
  runner — proving the one lockfile resolves the linux rolldown binding.

## Files touched

**New**
- `ui/pnpm-lock.yaml`
- `.nvmrc`

**Edited**
- `ui/package.json` (`packageManager`, exact devDep versions, `engines.node`)
- `.github/workflows/release.yml` (frontend-build step)
- `CLAUDE.md`, `README.md` (commands), `docs/RELEASES.md` (if it mentions the npm step)

**Removed**
- `ui/package-lock.json`

## Out of scope

- **Effort B** (codify the runner setup) — separate spec.
- The `gen/schemas/*.json` tracked-generated-file noise — separate.
- Switching the Rust/cargo side or pinning Rust deps — unrelated.
