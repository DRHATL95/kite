# Gitea → GitHub Migration Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Move the project from self-hosted Gitea to GitHub — private code repo + public releases repo — keeping CI/CD on the self-hosted runner and the in-app auto-updater working.

**Architecture:** Two repos: `DRHATL95/xbox-remote` (private, code + CI) and `DRHATL95/xbox-remote-releases` (public, binaries + `latest.json` the updater reads anonymously). CI is a near-verbatim port of the Gitea workflow to GitHub Actions on the self-hosted runner, publishing cross-repo via `gh release` + a PAT. The same signing keypair is reused, so existing installs need only a one-time manual reinstall.

**Tech Stack:** GitHub Actions (self-hosted runner), `gh` CLI, Tauri v2 updater, `cargo-xwin` cross-compile, bash publish scripts, Rust, Svelte/Vite.

**Note on testing:** This migration is mostly infra (git/`gh`/CI), not unit-testable code. The one code change (`updater.rs`) is done test-first. Everything else is verified with concrete commands (git/gh state checks, `cargo test`, `npm` check/build, YAML + `bash -n` lint, a `grep` sweep for stray Gitea refs). True end-to-end validation (an actual CI run) is gated on the user's runner + secrets (Task 7) and happens in Task 8.

**Reference:** Design spec at `docs/superpowers/specs/2026-06-17-github-migration-design.md`.

---

## File Structure

**New**
- `.github/workflows/release.yml` — GitHub Actions release pipeline (ported).
- `scripts/ci/github-release.sh` — `gh`-based cross-repo release publishing.

**Edited**
- `tauri.conf.json` — updater endpoint → public releases repo.
- `src/updater.rs` — `channel_endpoint` host → public releases repo.
- `CLAUDE.md`, `docs/RELEASES.md`, `README.md` — docs.

**Removed**
- `.gitea/workflows/release.yml` (and the now-empty `.gitea/`).
- `scripts/ci/gitea-release.sh`.

**Unchanged (reused)**
- `scripts/ci/make-latest-json.sh` — its URL inputs are supplied by the workflow.

---

## Task 1: Create GitHub repos, push history, configure remotes

**Files:** none (git/gh infrastructure). Run from the repo root.

- [ ] **Step 1: Fetch the current Gitea master (source of truth, incl. the merged PR #8)**

Run: `git fetch origin`
Expected: completes; `git rev-parse origin/master` resolves to the latest Gitea master.

- [ ] **Step 2: Create the private code repo**

Run: `gh repo create DRHATL95/xbox-remote --private`
Expected: `✓ Created repository DRHATL95/xbox-remote on GitHub`

- [ ] **Step 3: Add the GitHub remote and push full history + tags**

```bash
git remote add github https://github.com/DRHATL95/xbox-remote.git
git push github refs/remotes/origin/master:refs/heads/master
git push github --tags
```
Expected: branch `master` and all tags appear on GitHub. Verify: `gh repo view DRHATL95/xbox-remote --json defaultBranchRef -q .defaultBranchRef.name` → `master`.

- [ ] **Step 4: Create + initialize the public releases repo**

Run: `gh repo create DRHATL95/xbox-remote-releases --public --add-readme`
Expected: `✓ Created repository …`. The `--add-readme` gives it one commit so release tags can be created later. Verify: `gh repo view DRHATL95/xbox-remote-releases --json visibility -q .visibility` → `PUBLIC`.

- [ ] **Step 5: Make GitHub the default remote; keep Gitea as an inactive mirror**

```bash
git remote rename origin gitea
git remote rename github origin
git remote -v
```
Expected: `origin` → `https://github.com/DRHATL95/xbox-remote.git`, `gitea` → `https://gitea.howlab.co/dave/xbox-remote.git`.
(Note: remotes are shared across worktrees, so the main checkout's `origin` now also points at GitHub — intended.)

- [ ] **Step 6: Create the migration working branch and bring the spec commit onto it**

Capture the branch you're currently on (it holds the migration spec + plan doc
commits), branch from GitHub master, then replay exactly the commits not already
in master:

```bash
PRIOR="$(git rev-parse --abbrev-ref HEAD)"   # e.g. claude/brave-black-470088
git fetch origin
git switch -c migrate-to-github origin/master
git cherry-pick "origin/master..$PRIOR"
git log --oneline -3
```
Expected: on branch `migrate-to-github`; the top commits are the migration spec
and plan docs. The range form replays only the spec/plan doc commits — the
console-identity feature reached master via Gitea's PR #8 merge, so those commits
are already ancestors of `origin/master` and the range excludes them.

- [ ] **Step 7: No commit** — Task 1 produces no working-tree changes (only remote/branch state). Proceed to Task 2.

---

## Task 2: Port the release workflow to GitHub Actions

**Files:**
- Create: `.github/workflows/release.yml`

- [ ] **Step 1: Create the workflow file**

Create `.github/workflows/release.yml` with exactly:

```yaml
name: release

# Nightly: every push to master -> rolling "nightly" release in the PUBLIC
#          releases repo (version <target>-nightly.<run_number>).
# Stable:  pushing a v* tag    -> permanent vX.Y.Z archive + rolling "stable".
#
# Single job on the SELF-HOSTED Linux runner producing BOTH platforms:
#   - Windows installer CROSS-COMPILED via cargo-xwin.
#   - Linux AppImage built NATIVELY on the same runner.
# Releases are published CROSS-REPO to DRHATL95/xbox-remote-releases (public) so
# the in-app updater can read latest.json + binaries anonymously, while this code
# repo stays private. Cross-repo auth uses the RELEASES_TOKEN PAT.
on:
  push:
    branches: [master]
    tags: ['v*']

permissions:
  contents: read

jobs:
  release:
    runs-on: [self-hosted, Linux, X64]
    env:
      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
      XWIN_ACCEPT_LICENSE: "1"
      APPIMAGE_EXTRACT_AND_RUN: "1"
      RELEASES_REPO: DRHATL95/xbox-remote-releases
    steps:
      - uses: actions/checkout@v4

      # GTK/WebKit dev libs + AppImage tooling for the NATIVE Linux bundle.
      # Best baked into the runner image; kept here so a fresh runner still works.
      - name: Install Linux build dependencies
        shell: bash
        run: |
          sudo apt-get update
          sudo apt-get install -y --no-install-recommends \
            build-essential libgtk-3-dev libwebkit2gtk-4.1-dev \
            libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2 file

      - name: Compute version + channel
        id: v
        shell: bash
        run: |
          if [[ "${{ github.ref }}" == refs/tags/v* ]]; then
            VER="${{ github.ref_name }}"; VER="${VER#v}"
            { echo "version=$VER"; echo "pointer_tag=stable"; echo "archive_tag=v$VER";
              echo "name=v$VER"; echo "prerelease=false"; } >> "$GITHUB_OUTPUT"
          else
            TARGET="$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')"
            VER="${TARGET}-nightly.${{ github.run_number }}"
            { echo "version=$VER"; echo "pointer_tag=nightly"; echo "archive_tag=";
              echo "name=Nightly $VER"; echo "prerelease=true"; } >> "$GITHUB_OUTPUT"
          fi

      - name: Build frontend
        run: |
          # rolldown ships a platform-gated native binary as an optionalDependency;
          # the committed lockfile is Windows-generated, so nuke lockfile+modules and
          # install fresh so the Linux binding resolves on this runner.
          rm -rf ui/node_modules ui/package-lock.json
          npm --prefix ui install --no-audit --no-fund
          npm --prefix ui run build

      - name: Tauri cross-build (signed NSIS for Windows x64)
        shell: bash
        run: |
          printf '{"version":"%s"}' "${{ steps.v.outputs.version }}" > ci-version.json
          cargo tauri build --runner cargo-xwin --target x86_64-pc-windows-msvc \
            --bundles nsis --config ci-version.json

      - name: Tauri build (signed AppImage for Linux x64)
        shell: bash
        run: |
          cargo tauri build --bundles appimage --config ci-version.json

      - name: Stage artifacts
        shell: bash
        run: |
          v='${{ steps.v.outputs.version }}'
          mkdir -p dist
          cp "target/x86_64-pc-windows-msvc/release/bundle/nsis/Xbox Remote_${v}_x64-setup.exe"     "dist/xbox-remote_${v}_x64-setup.exe"
          cp "target/x86_64-pc-windows-msvc/release/bundle/nsis/Xbox Remote_${v}_x64-setup.exe.sig" "dist/xbox-remote_${v}_x64-setup.exe.sig"
          cp "target/release/bundle/appimage/Xbox Remote_${v}_amd64.AppImage"     "dist/xbox-remote_${v}_amd64.AppImage"
          cp "target/release/bundle/appimage/Xbox Remote_${v}_amd64.AppImage.sig" "dist/xbox-remote_${v}_amd64.AppImage.sig"

      - name: Build latest.json
        shell: bash
        run: |
          VERSION='${{ steps.v.outputs.version }}'
          POINTER='${{ steps.v.outputs.pointer_tag }}'
          # Asset URLs point at the rolling pointer release in the PUBLIC releases repo.
          base="https://github.com/${RELEASES_REPO}/releases/download/${POINTER}"
          export VERSION
          PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          NOTES='${{ steps.v.outputs.name }}' \
          WIN_SIG_FILE="dist/xbox-remote_${VERSION}_x64-setup.exe.sig" \
          WIN_URL="${base}/xbox-remote_${VERSION}_x64-setup.exe" \
          LINUX_SIG_FILE="dist/xbox-remote_${VERSION}_amd64.AppImage.sig" \
          LINUX_URL="${base}/xbox-remote_${VERSION}_amd64.AppImage" \
          bash scripts/ci/make-latest-json.sh > dist/latest.json
          cat dist/latest.json

      - name: Publish release + assets (cross-repo to the public releases repo)
        shell: bash
        env:
          GH_TOKEN: ${{ secrets.RELEASES_TOKEN }}
        run: |
          VERSION='${{ steps.v.outputs.version }}'
          POINTER='${{ steps.v.outputs.pointer_tag }}'
          ARCHIVE='${{ steps.v.outputs.archive_tag }}'
          RELEASE_NAME='${{ steps.v.outputs.name }}'
          PRERELEASE='${{ steps.v.outputs.prerelease }}'
          source scripts/ci/github-release.sh

          assets=(
            "xbox-remote_${VERSION}_x64-setup.exe"
            "xbox-remote_${VERSION}_x64-setup.exe.sig"
            "xbox-remote_${VERSION}_amd64.AppImage"
            "xbox-remote_${VERSION}_amd64.AppImage.sig"
          )

          # Update the rolling pointer IN PLACE: ensure release -> upload binaries
          # (clobber) -> swap latest.json LAST -> prune stale assets. Never delete
          # the release, so its latest.json is never missing.
          ensure_release "$POINTER" "$RELEASE_NAME" "$PRERELEASE"
          for f in "${assets[@]}"; do
            replace_asset "$POINTER" "dist/$f"
          done
          replace_asset "$POINTER" "dist/latest.json"
          prune_channel_assets "$POINTER" "$VERSION"

          # Stable also gets a permanent vX.Y.Z archive (binaries only).
          if [ -n "$ARCHIVE" ]; then
            create_archive_release "$ARCHIVE" "$RELEASE_NAME"
            for f in "${assets[@]}"; do
              replace_asset "$ARCHIVE" "dist/$f"
            done
          fi
```

- [ ] **Step 2: Validate the YAML parses**

Run: `node -e "require('js-yaml')" 2>/dev/null && node -e "const y=require('js-yaml');y.load(require('fs').readFileSync('.github/workflows/release.yml','utf8'));console.log('yaml ok')" || python -c "import yaml,sys; yaml.safe_load(open('.github/workflows/release.yml')); print('yaml ok')"`
Expected: `yaml ok` (uses whichever of node-js-yaml / python-yaml is present).

- [ ] **Step 3: Commit**

```bash
git add .github/workflows/release.yml
git commit -m "ci(github): port release workflow to GitHub Actions (self-hosted)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 3: Add the gh-based publish script; remove the Gitea pipeline

**Files:**
- Create: `scripts/ci/github-release.sh`
- Remove: `scripts/ci/gitea-release.sh`, `.gitea/workflows/release.yml`

- [ ] **Step 1: Create `scripts/ci/github-release.sh`**

Create `scripts/ci/github-release.sh` with exactly:

```bash
#!/usr/bin/env bash
# GitHub release helpers (gh CLI), sourced by the publish step. Publishes
# CROSS-REPO to the public releases repo so the updater can read assets
# anonymously while the code repo stays private.
# Requires env: RELEASES_REPO (owner/name), GH_TOKEN (PAT with contents:write
# on RELEASES_REPO). gh + jq are preinstalled on the runner.
set -euo pipefail
: "${RELEASES_REPO:?}"; : "${GH_TOKEN:?}"

# ensure_release <tag> <name> <prerelease:true|false>
# Reuse the rolling release if present (refresh title/prerelease); create if absent.
# Rolling tags ("nightly"/"stable") are created at the releases repo's default HEAD;
# the tag commit is cosmetic (the updater reads latest.json, not the tag).
ensure_release() {
  local tag="$1" name="$2" pre="$3"
  if gh release view "$tag" --repo "$RELEASES_REPO" >/dev/null 2>&1; then
    gh release edit "$tag" --repo "$RELEASES_REPO" --title "$name" --prerelease="$pre" >/dev/null
  else
    local flag=""; [ "$pre" = "true" ] && flag="--prerelease"
    gh release create "$tag" --repo "$RELEASES_REPO" --title "$name" --notes "$name" $flag >/dev/null
  fi
  echo "ensured release: $tag"
}

# replace_asset <tag> <file> — upload, clobbering any same-named asset.
# --clobber deletes-then-uploads, giving the atomic "swap latest.json last" guarantee.
replace_asset() {
  gh release upload "$1" "$2" --repo "$RELEASES_REPO" --clobber >/dev/null
  echo "uploaded: $(basename "$2")"
}

# prune_channel_assets <tag> <keep_version> — delete assets that are neither the
# current version's binaries nor latest.json. Run AFTER the latest.json swap.
prune_channel_assets() {
  local tag="$1" ver="$2" name
  while IFS= read -r name; do
    [ -z "$name" ] && continue
    case "$name" in
      *"$ver"*)    ;;  # keep current-version binaries
      latest.json) ;;  # keep the manifest
      *) gh release delete-asset "$tag" "$name" --repo "$RELEASES_REPO" -y >/dev/null || true
         echo "pruned: $name" ;;
    esac
  done < <(gh release view "$tag" --repo "$RELEASES_REPO" --json assets -q '.assets[].name')
}

# create_archive_release <tag> <name> — permanent vX.Y.Z (fails if it already
# exists; stable tags are cut once).
create_archive_release() {
  gh release create "$1" --repo "$RELEASES_REPO" --title "$2" --notes "$2" >/dev/null
  echo "created archive release: $1"
}
```

- [ ] **Step 2: Syntax-check the script**

Run: `bash -n scripts/ci/github-release.sh && echo "bash ok"`
Expected: `bash ok` (no syntax errors).

- [ ] **Step 3: Remove the Gitea pipeline**

```bash
git rm .gitea/workflows/release.yml scripts/ci/gitea-release.sh
```
Expected: both files staged for deletion. (`.gitea/` becomes empty and is dropped.)

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/github-release.sh
git commit -m "ci(github): gh-based cross-repo publish; drop Gitea pipeline

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 4: Updater endpoint cutover (test-first)

**Files:**
- Modify: `src/updater.rs` (the `channel_endpoint` fn + tests)
- Modify: `tauri.conf.json` (updater endpoint)

- [ ] **Step 1: Add a failing test for the new host**

In `src/updater.rs`, inside `mod tests`, add this test after `unknown_channel_falls_back_to_stable`:

```rust
    #[test]
    fn uses_github_releases_host() {
        let url = channel_endpoint("stable");
        assert!(
            url.starts_with("https://github.com/DRHATL95/xbox-remote-releases/releases/download/"),
            "unexpected endpoint host: {url}"
        );
    }
```

- [ ] **Step 2: Run it to verify it fails**

Run: `cargo test --lib updater:: 2>&1 | tail -20`
Expected: FAIL — `uses_github_releases_host` panics with `unexpected endpoint host: https://gitea.howlab.co/...` (the existing suffix tests still pass).

- [ ] **Step 3: Repoint `channel_endpoint`**

In `src/updater.rs`, replace the body of `channel_endpoint` (line ~9):

```rust
    format!("https://gitea.howlab.co/dave/xbox-remote/releases/download/{ch}/latest.json")
```

with:

```rust
    format!("https://github.com/DRHATL95/xbox-remote-releases/releases/download/{ch}/latest.json")
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `cargo test --lib updater:: 2>&1 | tail -20`
Expected: PASS — all `updater::tests` green (the new host test plus the existing suffix/fallback tests).

- [ ] **Step 5: Repoint the static updater endpoint in `tauri.conf.json`**

In `tauri.conf.json`, replace the updater endpoint (line ~54):

```json
        "https://gitea.howlab.co/dave/xbox-remote/releases/download/stable/latest.json"
```

with:

```json
        "https://github.com/DRHATL95/xbox-remote-releases/releases/download/stable/latest.json"
```

Leave `pubkey` unchanged (same signing keypair).

- [ ] **Step 6: Verify the config still builds**

Run: `cargo build 2>&1 | tail -5`
Expected: builds successfully (Tauri validates `tauri.conf.json` at build; no schema/parse error).

- [ ] **Step 7: Commit**

```bash
git add src/updater.rs tauri.conf.json
git commit -m "feat(updater): point update channels at the public GitHub releases repo

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 5: Documentation

**Files:**
- Modify: `CLAUDE.md`, `docs/RELEASES.md`, `README.md`

- [ ] **Step 1: Replace the CI/CD section in `CLAUDE.md`**

In `CLAUDE.md`, replace the entire `### Releases & Auto-Update (CI/CD)` subsection (from that heading through the end of its bullet list, ending with the "macOS is still build-from-source" gotcha) with:

```markdown
### Releases & Auto-Update (CI/CD)

Releases are built by **GitHub Actions** (`.github/workflows/release.yml`) on a
**self-hosted** Linux runner (Proxmox LXC CT 106). The project uses **two repos**:

- **Code (private)**: `DRHATL95/xbox-remote` — source + the CI workflow.
- **Releases (public)**: `DRHATL95/xbox-remote-releases` — only binaries + `.sig`
  + per-channel `latest.json`. It is public so the Tauri updater can fetch
  `latest.json` and installers anonymously while the code stays private.

- **Nightly**: every push to `master` builds **both** platforms in one job and
  force-updates the rolling `nightly` release in the releases repo. Windows NSIS
  is cross-compiled (`cargo tauri build --runner cargo-xwin --target
  x86_64-pc-windows-msvc --bundles nsis`); the Linux AppImage is built natively
  on the same runner. Both updater artifacts are signed. Nightly version =
  `<target>-nightly.<run_number>` (committed `Cargo.toml` version = next
  unreleased `X.Y.Z`), injected via `--config` so the tree stays clean.
- **Stable**: pushing a `vX.Y.Z` tag cuts a permanent `vX.Y.Z` archive release
  **and** force-updates the rolling `stable` pointer. After cutting a stable, bump
  the committed target.
- **Publishing**: `scripts/ci/github-release.sh` (gh CLI) publishes **cross-repo**
  to the releases repo via the `RELEASES_TOKEN` PAT — ensure rolling release →
  upload binaries (`--clobber`) → swap `latest.json` last → prune stale assets.
- **In-app updates**: the app checks the active channel's `latest.json` on launch
  (`tauri-plugin-updater`; UI in `ui/src/lib/update/` + `UpdateBanner.svelte`).
  Two channels: `…/releases/download/{nightly,stable}/latest.json` on the public
  releases repo. On Linux the updater only updates **AppImage** installs.
- **Secrets** (on the private repo): `TAURI_SIGNING_PRIVATE_KEY` (+ `_PASSWORD`)
  for signing — public key embedded in `tauri.conf.json`; and `RELEASES_TOKEN`, a
  PAT with `contents:write` on the releases repo for cross-repo publishing. The
  signing private key lives at `~/.tauri/xbox-remote-updater.key` — keep a backup;
  **never commit it**.
- **Runner**: a self-hosted GitHub Actions runner on CT 106 (label set
  `[self-hosted, Linux, X64]`). Build deps baked in: clang/lld/llvm, nsis, rust
  target `x86_64-pc-windows-msvc`, `cargo-xwin`, warm xwin SDK cache, plus the
  GTK/WebKit dev libs + AppImage tooling (`libgtk-3-dev libwebkit2gtk-4.1-dev
  libayatana-appindicator3-dev librsvg2-dev patchelf libfuse2`). Use the
  **ayatana** appindicator, not legacy `libappindicator3-dev`.
- **Gotchas**: every `master` push — even docs-only — produces a new nightly and
  an update prompt. macOS is still build-from-source.
```

- [ ] **Step 2: Update `docs/RELEASES.md` — authoritative-source line**

Replace (line ~5):

```markdown
source is `.gitea/workflows/release.yml`; this document explains the *why*.
```

with:

```markdown
source is `.github/workflows/release.yml`; this document explains the *why*.
```

- [ ] **Step 3: Update `docs/RELEASES.md` — nightly run-counter wording**

Replace (line ~64):

```markdown
  `Cargo.toml` version and `<run_number>` is the Gitea Actions run counter
```

with:

```markdown
  `Cargo.toml` version and `<run_number>` is the GitHub Actions run counter
```

- [ ] **Step 4: Update `docs/RELEASES.md` — nightly publish script reference**

Replace (line ~66-68):

```markdown
- Publishes to a **single rolling release tagged `nightly`**. Each build deletes
  and recreates that release's assets (`roll_channel` in
  `scripts/ci/gitea-release.sh`), so `releases/download/nightly/…` URLs are stable
  and always point at the newest build.
```

with:

```markdown
- Publishes to a **single rolling release tagged `nightly`** in the public
  releases repo. Each build replaces that release's assets in place
  (`scripts/ci/github-release.sh`), so `releases/download/nightly/…` URLs are
  stable and always point at the newest build.
```

- [ ] **Step 5: Update `docs/RELEASES.md` — the auto-update manifest URLs**

Replace (line ~94-97):

```markdown
https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/latest.json
https://gitea.howlab.co/dave/xbox-remote/releases/download/stable/latest.json
```

with:

```markdown
https://github.com/DRHATL95/xbox-remote-releases/releases/download/nightly/latest.json
https://github.com/DRHATL95/xbox-remote-releases/releases/download/stable/latest.json
```

- [ ] **Step 6: Update `docs/RELEASES.md` — offline note (no longer LAN-only)**

Replace (line ~106-107):

```markdown
3. Offline / off-LAN, the check silently no-ops — `gitea.howlab.co` is only
   reachable on the home network.
```

with:

```markdown
3. Offline, the check silently no-ops. The releases repo is public on GitHub, so
   the check works from anywhere with internet (no LAN dependency).
```

- [ ] **Step 7: Update `docs/RELEASES.md` — signing-secret host**

Replace (line ~128):

```markdown
Update artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` (Gitea Actions
secret; public key embedded in `tauri.conf.json`). The `.sig` signs the file
```

with:

```markdown
Update artifacts are signed with `TAURI_SIGNING_PRIVATE_KEY` (GitHub Actions
secret; public key embedded in `tauri.conf.json`). The `.sig` signs the file
```

- [ ] **Step 8: Update `docs/RELEASES.md` — the single-job rationale paragraph**

Replace (line ~139-143):

```markdown
Both artifacts are produced in a *single* job — the `upload-artifact` action
refuses non-GitHub hosts, so there is no cross-job handoff. The Linux build
needs GTK/WebKit dev libs + AppImage tooling on the runner; the workflow installs
them defensively but they're best baked into the runner image. See `CLAUDE.md` →
"Releases & Auto-Update (CI/CD)" for the runner details.
```

with:

```markdown
Both artifacts are produced in a *single* job on the self-hosted runner, then
published cross-repo to the public releases repo via `gh release`. The Linux
build needs GTK/WebKit dev libs + AppImage tooling on the runner; the workflow
installs them defensively but they're best baked into the runner image. See
`CLAUDE.md` → "Releases & Auto-Update (CI/CD)" for the runner details.
```

- [ ] **Step 9: Update the clone URL in `README.md`**

Replace (line ~45):

```
git clone <your-repo-url>
```

with:

```
git clone https://github.com/DRHATL95/xbox-remote.git
```

- [ ] **Step 10: Verify no stray Gitea references remain outside historical docs**

Run: `grep -rIn -e gitea -e howlab . --include='*.md' --include='*.rs' --include='*.json' --include='*.yml' --include='*.sh' | grep -v 'docs/superpowers/specs/2026-06-1[0-9]' | grep -v 'docs/superpowers/plans/2026-06-0' | grep -v 'docs/superpowers/plans/2026-06-13'`
Expected: no output. (The only remaining matches are historical dated spec/plan docs, which are intentionally left as records. If any *active* file shows up, fix it.)

- [ ] **Step 11: Commit**

```bash
git add CLAUDE.md docs/RELEASES.md README.md
git commit -m "docs: update CI/CD + auto-update docs for the GitHub two-repo model

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>"
```

---

## Task 6: Verify the branch end-to-end (offline) and open the PR

**Files:** none (verification + push).

- [ ] **Step 1: Rust tests**

Run: `cargo test 2>&1 | tail -15`
Expected: all tests pass (including `updater::tests`).

- [ ] **Step 2: Frontend check + build**

Run: `npm --prefix ui run check && npm --prefix ui run build 2>&1 | tail -3`
Expected: svelte-check 0 errors / 0 warnings; build writes `ui/dist`.

- [ ] **Step 3: Confirm the Gitea workflow + script are gone and the GitHub ones exist**

Run: `ls .github/workflows/release.yml scripts/ci/github-release.sh; test ! -e .gitea/workflows/release.yml && echo "gitea workflow removed"; test ! -e scripts/ci/gitea-release.sh && echo "gitea script removed"`
Expected: the two GitHub paths list; both "removed" lines print.

- [ ] **Step 4: Push the migration branch to GitHub**

Run: `git push -u origin migrate-to-github`
Expected: branch pushed to `DRHATL95/xbox-remote`.

- [ ] **Step 5: Open the PR**

```bash
gh pr create --repo DRHATL95/xbox-remote --base master --head migrate-to-github \
  --title "Migrate CI/CD + updater from Gitea to GitHub" \
  --body "Ports the release pipeline to GitHub Actions (self-hosted), publishes releases cross-repo to the public DRHATL95/xbox-remote-releases, and repoints the in-app updater. Spec: docs/superpowers/specs/2026-06-17-github-migration-design.md

Merging triggers the first nightly — do the runner + secrets setup (Task 7) first."
```
Expected: prints the new PR URL. **Do not merge yet** — Task 7 (runner + secrets) must land first, or the first nightly will fail.

---

## Task 7: [USER-GUIDED] Secrets + self-hosted runner

**This task is performed by the user** — it involves credentials and infrastructure the assistant must not handle. The assistant provides the exact commands and verifies completion; the user runs them.

- [ ] **Step 1: Create the cross-repo publish PAT**

The user creates a Personal Access Token with **`contents: write`** on `DRHATL95/xbox-remote-releases`:
- Fine-grained PAT (recommended): GitHub → Settings → Developer settings → Fine-grained tokens → repo access = `xbox-remote-releases`, Repository permissions → Contents: Read and write.
- Then set it as a secret on the **private** repo:

Run (user): `gh secret set RELEASES_TOKEN -R DRHATL95/xbox-remote`
(paste the PAT when prompted)

- [ ] **Step 2: Set the signing secrets (user handles the private key)**

Run (user):
```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY -R DRHATL95/xbox-remote < ~/.tauri/xbox-remote-updater.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD -R DRHATL95/xbox-remote
```
(the password is empty per project setup — press Enter at the prompt, or set the real value if one was used)

- [ ] **Step 3: Verify the secrets exist**

Run: `gh secret list -R DRHATL95/xbox-remote`
Expected: `RELEASES_TOKEN`, `TAURI_SIGNING_PRIVATE_KEY`, `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` listed.

- [ ] **Step 4: Register the self-hosted runner on CT 106**

On CT 106 (which already has the build deps), the user installs + registers the GitHub Actions runner against the private repo using a registration token from GitHub → Settings → Actions → Runners → New self-hosted runner (Linux). The runner gets the default `self-hosted, Linux, X64` labels (matching the workflow's `runs-on`). Start it as a service (`./svc.sh install && ./svc.sh start`).

- [ ] **Step 5: Verify the runner is online**

Run: `gh api repos/DRHATL95/xbox-remote/actions/runners -q '.runners[] | "\(.name) \(.status)"'`
Expected: the runner listed as `online`.

---

## Task 8: End-to-end validation (gated on Task 7)

**Files:** none.

- [ ] **Step 1: Merge the migration PR to trigger the first nightly**

Run: `gh pr merge migrate-to-github --repo DRHATL95/xbox-remote --merge`
Expected: PR merges to `master`, which triggers the `release` workflow.

- [ ] **Step 2: Watch the workflow run**

Run: `gh run watch -R DRHATL95/xbox-remote $(gh run list -R DRHATL95/xbox-remote -L1 --json databaseId -q '.[0].databaseId')`
Expected: the `release` job completes successfully on the self-hosted runner.

- [ ] **Step 3: Confirm the nightly release published to the public repo**

Run: `gh release view nightly -R DRHATL95/xbox-remote-releases --json assets -q '.assets[].name'`
Expected: lists `latest.json`, the `_x64-setup.exe` (+`.sig`), and the `_amd64.AppImage` (+`.sig`).

- [ ] **Step 4: Confirm `latest.json` is anonymously reachable**

Run: `curl -fsSL https://github.com/DRHATL95/xbox-remote-releases/releases/download/nightly/latest.json | head -c 400; echo`
Expected: prints the JSON manifest (version, platforms, signed URLs) — no auth required.

- [ ] **Step 5: Confirm the in-app updater (manual)**

Install the new nightly build and confirm the app's launch update check reaches GitHub (a subsequent nightly offers an update). Existing Gitea-pointed installs are replaced by installing this build once (reinstall-once cutover).

---

## Self-Review (completed during planning)

- **Spec coverage:** Part A → Task 1; Part B → Tasks 2-3; Part C → Task 4; Part D → Task 5; user steps → Task 7; e2e validation → Task 8; verification → Task 6. All spec sections covered.
- **Placeholder scan:** No TBD/TODO. Infra/user steps that can't be unit-tested have explicit verification commands with expected output. The `<your-repo-url>` placeholder in README is itself the thing being fixed (Task 5, Step 9).
- **Consistency:** `RELEASES_REPO=DRHATL95/xbox-remote-releases`, `RELEASES_TOKEN`, and the `…/releases/download/{nightly,stable}/latest.json` URL shape are identical across the workflow (Task 2), the publish script (Task 3), the updater (Task 4), and the docs (Task 5). The script functions `ensure_release` / `replace_asset` / `prune_channel_assets` / `create_archive_release` are defined in Task 3 and called with matching signatures in Task 2's publish step.
