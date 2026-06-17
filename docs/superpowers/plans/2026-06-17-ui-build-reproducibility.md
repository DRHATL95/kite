# UI Build Reproducibility (pnpm) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make `ui/` builds reproducible by migrating to pnpm (via corepack) with a committed cross-platform `pnpm-lock.yaml` and a frozen CI install, eliminating `latest` drift and the lockfile-nuke hack.

**Architecture:** pnpm's lockfile records all platform variants of native optional deps (the vite/rolldown bindings), so one committed `pnpm-lock.yaml` resolves on Windows (local) and Linux (CI). Corepack pins the pnpm version from `package.json`'s `packageManager` field, so nothing is installed manually. CI installs with `--frozen-lockfile` for drift-proof builds.

**Tech Stack:** pnpm 11.7.0 (via corepack), node 20 (runner) / corepack-provisioned, Vite 8 + rolldown, Svelte 5, Vitest, svelte-check.

**Note on testing:** This is config/build-infra, not application code — there are no unit tests to write. "Verification" is the existing `check`/`test`/`build` scripts passing *through pnpm with a frozen lockfile*, plus a CI run proving the one lockfile resolves the Linux rolldown binding.

**Corepack note (local, Windows):** `corepack enable` writes shims into the node install dir and may need an elevated shell on Windows. If it errors, use `corepack prepare pnpm@11.7.0 --activate` instead (no elevation), then `pnpm …`. On the Linux runner (root) `corepack enable` works directly.

**Reference:** spec at `docs/superpowers/specs/2026-06-17-ui-build-reproducibility-design.md`.

---

## File Structure

**New**
- `ui/pnpm-lock.yaml` — the cross-platform lockfile (generated).
- `.nvmrc` — documents node 20.

**Edited**
- `ui/package.json` — `packageManager`, exact devDep versions, `engines.node`.
- `.github/workflows/release.yml` — frontend-build step → pnpm + frozen install.
- `CLAUDE.md`, `README.md` — `npm --prefix ui` → `pnpm --dir ui`; corepack note.

**Removed**
- `ui/package-lock.json`.

---

## Task 1: Pin deps + pnpm/node config in `ui/package.json` + `.nvmrc`

**Files:**
- Modify: `ui/package.json`
- Create: `.nvmrc`

- [ ] **Step 1: Pin devDeps, add `packageManager` + `engines`**

Replace the `devDependencies` block and add the two top-level fields. The full `ui/package.json` becomes:

```json
{
  "name": "xbox-remote-ui",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "packageManager": "pnpm@11.7.0",
  "engines": {
    "node": ">=20"
  },
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "check": "svelte-check --tsconfig ./tsconfig.json",
    "test": "vitest run"
  },
  "dependencies": {
    "@fontsource-variable/hanken-grotesk": "^5.2.8",
    "@fontsource/chakra-petch": "^5.2.7",
    "@fontsource/ibm-plex-mono": "^5.2.7",
    "@tauri-apps/api": "^2",
    "@tauri-apps/plugin-opener": "^2",
    "svelte": "^5"
  },
  "devDependencies": {
    "@sveltejs/vite-plugin-svelte": "7.1.2",
    "@tsconfig/svelte": "5.0.8",
    "jsdom": "^29.1.1",
    "svelte-check": "4.6.0",
    "typescript": "6.0.3",
    "vite": "8.0.16",
    "vitest": "4.1.9"
  }
}
```

- [ ] **Step 2: Create `.nvmrc`**

Create `.nvmrc` at the repo root containing exactly:

```
20
```

- [ ] **Step 3: Verify `package.json` is valid JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('ui/package.json','utf8')); console.log('json ok')"`
Expected: `json ok`

- [ ] **Step 4: Commit**

```bash
git add ui/package.json .nvmrc
git commit -m "build(ui): pin devDeps + declare pnpm/node via packageManager+engines

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 2: Generate `pnpm-lock.yaml`, drop `package-lock.json`, verify locally

**Files:**
- Create: `ui/pnpm-lock.yaml`
- Remove: `ui/package-lock.json`

- [ ] **Step 1: Activate pnpm via corepack**

Run: `corepack enable` (or, if it errors on Windows, `corepack prepare pnpm@11.7.0 --activate`)
Then: `pnpm --version`
Expected: `11.7.0`

- [ ] **Step 2: Generate the lockfile + install**

Run: `pnpm --dir ui install`
Expected: completes; creates `ui/pnpm-lock.yaml` and `ui/node_modules`. The lockfile records the rolldown bindings for multiple platforms (e.g. `@rolldown/binding-win32-x64-msvc` and `@rolldown/binding-linux-x64-gnu`).

- [ ] **Step 3: Confirm the lockfile is cross-platform**

Run: `grep -c 'binding-linux-x64-gnu' ui/pnpm-lock.yaml`
Expected: `≥ 1` (the Linux rolldown binding is present in a lockfile generated on Windows — this is the whole point).

- [ ] **Step 4: Remove the npm lockfile**

```bash
git rm ui/package-lock.json
```
Expected: staged for deletion.

- [ ] **Step 5: Verify check / test / build through pnpm**

```bash
pnpm --dir ui run check
pnpm --dir ui run test
pnpm --dir ui run build
```
Expected: svelte-check `0 errors / 0 warnings`; vitest all pass (214 tests as of this branch); `vite build` writes `ui/dist`.

- [ ] **Step 6: Verify a frozen install is clean (reproducibility gate)**

Run: `pnpm --dir ui install --frozen-lockfile`
Expected: succeeds with no lockfile changes ("Lockfile is up to date" / no resolution). This is the exact command CI will run.

- [ ] **Step 7: Commit**

```bash
git add ui/pnpm-lock.yaml
git commit -m "build(ui): adopt pnpm lockfile; drop package-lock.json

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```
(The `git rm` from Step 4 is included in this commit.)

---

## Task 3: Update the CI frontend-build step

**Files:**
- Modify: `.github/workflows/release.yml`

- [ ] **Step 1: Replace the "Build frontend" step body**

In `.github/workflows/release.yml`, replace the entire `Build frontend` step:

```yaml
      - name: Build frontend
        run: |
          # rolldown ships a platform-gated native binary as an optionalDependency;
          # the committed lockfile is Windows-generated, so nuke lockfile+modules and
          # install fresh so the Linux binding resolves on this runner.
          rm -rf ui/node_modules ui/package-lock.json
          npm --prefix ui install --no-audit --no-fund
          npm --prefix ui run build
```

with:

```yaml
      - name: Build frontend
        run: |
          # pnpm's lockfile records all platform variants of the rolldown native
          # binding, so one committed pnpm-lock.yaml resolves on Linux here and on
          # Windows locally. corepack provisions the pinned pnpm from package.json's
          # packageManager field. --frozen-lockfile makes the lockfile authoritative.
          corepack enable
          pnpm --dir ui install --frozen-lockfile
          pnpm --dir ui run build
```

- [ ] **Step 2: Validate the YAML parses**

Run: `python -c "import yaml; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: `yaml ok`

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(ui): frozen pnpm install for reproducible frontend builds

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Docs sweep (npm → pnpm)

**Files:**
- Modify: `CLAUDE.md`, `README.md`

- [ ] **Step 1: Replace the npm prefix invocation in CLAUDE.md**

In `CLAUDE.md`, replace every occurrence of `npm --prefix ui` with `pnpm --dir ui`. (This turns `npm --prefix ui run build` → `pnpm --dir ui run build`, `npm --prefix ui install` → `pnpm --dir ui install`, etc.) Use an editor replace-all, then verify with the grep in Step 3.

- [ ] **Step 2: Replace the npm prefix invocation in README.md**

In `README.md`, replace every occurrence of `npm --prefix ui` with `pnpm --dir ui`. Also update the "Install frontend dependencies" comment if it says npm. Add a one-line first-time note near the first pnpm command:

```
# First time only: enable pnpm (bundled with node via corepack)
corepack enable
```

- [ ] **Step 3: Verify no stale npm-ui invocations remain in active docs**

Run: `grep -rn "npm --prefix ui" CLAUDE.md README.md docs/RELEASES.md`
Expected: no output. (Historical specs/plans under `docs/superpowers/` are dated records — leave them.)

- [ ] **Step 4: Commit**

```bash
git add CLAUDE.md README.md
git commit -m "docs: pnpm commands for the frontend (npm --prefix ui -> pnpm --dir ui)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Full verification + PR

**Files:** none (verification + push).

- [ ] **Step 1: Clean-room reproducibility check**

```bash
rm -rf ui/node_modules
pnpm --dir ui install --frozen-lockfile
pnpm --dir ui run check
pnpm --dir ui run test
pnpm --dir ui run build
```
Expected: frozen install succeeds from a clean `node_modules`; svelte-check 0/0; vitest green; `ui/dist` written. This proves the committed lockfile alone reproduces the full toolchain.

- [ ] **Step 2: Confirm the npm lockfile is gone and pnpm one is tracked**

Run: `git ls-files ui/package-lock.json ui/pnpm-lock.yaml`
Expected: only `ui/pnpm-lock.yaml` is listed.

- [ ] **Step 3: Push the branch**

Run: `git push -u origin ui-reproducibility`
Expected: branch pushed to `DRHATL95/xbox-remote`.

- [ ] **Step 4: Open the PR**

```bash
gh pr create --repo DRHATL95/xbox-remote --base master --head ui-reproducibility \
  --title "build: reproducible UI builds via pnpm" \
  --body "Migrate ui/ to pnpm (corepack) with a committed cross-platform pnpm-lock.yaml and a --frozen-lockfile CI install; pin the drifting 'latest' devDeps; drop package-lock.json. Fixes the rolldown cross-platform binding issue that forced CI to nuke the lockfile. Spec: docs/superpowers/specs/2026-06-17-ui-build-reproducibility-design.md

Merging triggers a nightly that exercises the new frozen pnpm install on the Linux runner."
```
Expected: prints the PR URL.

- [ ] **Step 5: Merge to validate on the runner (REQUIRES USER GO-AHEAD)**

Merging triggers a nightly that runs `pnpm install --frozen-lockfile` on the Linux runner — the real cross-platform proof. Because a merge auto-triggers a release, get explicit user authorization first, then:

```bash
gh pr merge ui-reproducibility --repo DRHATL95/xbox-remote --merge --delete-branch
```
Then watch the run and confirm the "Build frontend" step succeeds:

```bash
gh run watch "$(gh run list --repo DRHATL95/xbox-remote --workflow release.yml -L1 --json databaseId -q '.[0].databaseId')" --repo DRHATL95/xbox-remote --interval 30
```
Expected: run succeeds; the frontend step installs from the frozen lockfile (resolving the linux rolldown binding) with no nuke-and-reinstall.

---

## Self-Review (completed during planning)

- **Spec coverage:** pnpm+corepack → Task 1; pin devDeps → Task 1; pnpm-lock + drop package-lock → Task 2; frozen CI install → Task 3; node alignment (.nvmrc/engines) → Task 1; docs sweep → Task 4; verification → Tasks 2/5. All spec sections covered.
- **Placeholder scan:** Exact versions throughout (pnpm 11.7.0; devDeps pinned to resolved versions). No TBD/TODO. The one cross-platform claim (linux binding in the lockfile) is verified explicitly in Task 2 Step 3.
- **Consistency:** `pnpm --dir ui run <script>` form used consistently across Tasks 2-5; `packageManager: pnpm@11.7.0` matches the `corepack prepare pnpm@11.7.0` fallback and the `pnpm --version` expectation.
