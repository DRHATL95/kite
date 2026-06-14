# Release Versioning & Channels — SP1 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make stable releases clean (`vX.Y.Z`), nightlies honest prereleases of the next target (`X.Y.Z-nightly.<run>`), and publish a fixed-URL `stable` channel pointer alongside the `nightly` one.

**Architecture:** CI-only change. The committed version becomes the in-dev *target*; the release workflow derives the nightly version as a prerelease of it and the stable version from the tag. A generalized `roll_channel` helper force-updates a rolling pointer release per channel; stable builds also create the permanent `vX.Y.Z` archive. The in-app channel selector is SP2 (separate plan).

**Tech Stack:** Gitea Actions (bash), Tauri 2 NSIS/AppImage bundlers, `scripts/ci/*.sh`, jq.

**Spec:** [docs/superpowers/specs/2026-06-13-release-versioning-channels-design.md](../specs/2026-06-13-release-versioning-channels-design.md)

---

## File Structure

| File | Responsibility |
|---|---|
| `Cargo.toml`, `tauri.conf.json` | committed version = next target (`0.3.0`) |
| `scripts/ci/gitea-release.sh` | generalize `roll_nightly` → `roll_channel` (works for any rolling pointer) |
| `scripts/ci/make-latest-json.test.sh` | add a prerelease-version test case |
| `.gitea/workflows/release.yml` | prerelease nightly version; per-channel pointer publishing; stable archive |
| `docs/RELEASES.md`, `CLAUDE.md` | document the scheme |

**Note on the pending `fix/linux-appindicator-conflict` PR:** it also edits `release.yml`, `Cargo.toml`, `tauri.conf.json`. If it merges before this branch, rebase `feat/versioning-channels` on `master` first; Tasks 2/4/5 then patch the rebased text (the version may already read `0.2.0` — Task 2 still moves it to `0.3.0`). Resolve conflicts favoring this plan's end state.

Tooling: bash is available via the Bash tool. Run shell scripts with `bash <path>`.

---

## Task 1: NSIS prerelease spike (decision gate)

**Files:** none (investigation only). Decides whether the rest of the plan uses **prerelease** (Approach A) or **numeric** (Approach B) nightly versions.

This is the one risk flagged in the spec: Windows installer versions are numeric `a.b.c.d`, so we must confirm Tauri's NSIS bundler accepts a semver **prerelease** string before committing the workflow to it. Run this on the Windows dev machine (NSIS + tauri-cli already present per CLAUDE.md).

- [ ] **Step 1: Build an NSIS bundle with a prerelease version**

Run (PowerShell, from repo root):

```powershell
npm --prefix ui run build
cargo tauri build --bundles nsis --config '{\"version\":\"0.3.0-nightly.42\"}'
```

- [ ] **Step 2: Inspect the result**

Check whether the build succeeded and what version the artifacts carry:

```powershell
Get-ChildItem "target\release\bundle\nsis"
```

- **PASS** if a `.exe` (and, with `createUpdaterArtifacts`, a `.sig`) is produced without a version-parse error. Note the exact installer filename (Tauri may render the prerelease as `0.3.0-nightly.42` or fold it into a numeric `ProductVersion` — either is fine as long as the build succeeds and the updater `.sig` is emitted).
- **FAIL** if `cargo tauri build` errors on the version string (e.g. "invalid version" / NSIS `ProductVersion` rejection).

- [ ] **Step 3: Record the decision**

Append a one-line note to the spec's open-risk section recording the outcome:

```bash
# Example (PASS):
#   Edit docs/superpowers/specs/2026-06-13-release-versioning-channels-design.md
#   under "Open risk", add: "RESOLVED 2026-06-13: NSIS accepts prerelease; Approach A."
```

Then **choose the path for Task 4**:
- **PASS → Approach A** (default): nightly = `${TARGET}-nightly.${run_number}`.
- **FAIL → Approach B**: nightly = `0.${NEXT_MINOR}.${run_number}` (numeric), where the
  committed target's minor IS the nightly prefix — e.g. target `0.3.0` → nightly `0.3.<run>`.
  Stable stays clean (`vX.Y.Z`); only Task 4's nightly `VER=` line differs. Both are spelled out in Task 4.

- [ ] **Step 4: Commit the recorded decision (if the spec was edited)**

```bash
git add docs/superpowers/specs/2026-06-13-release-versioning-channels-design.md
git commit -m "docs(spec): record NSIS prerelease spike outcome"
```

---

## Task 2: Bump committed version to the next target (0.3.0)

**Files:**
- Modify: `Cargo.toml` (package `version`)
- Modify: `tauri.conf.json` (`version`)

Rationale: `0.2.x` nightlies already shipped, so the next prerelease line targets `0.3.0`. The nightly workflow derives its version from this value.

- [ ] **Step 1: Bump Cargo.toml**

In `Cargo.toml`, change the package version line (currently `version = "0.1.0"` on `master`, or `version = "0.2.0"` if the appindicator PR merged first) to:

```toml
version = "0.3.0"
```

- [ ] **Step 2: Bump tauri.conf.json**

In `tauri.conf.json`, change the top-level version (currently `"version": "0.1.0"` / `"0.2.0"`) to:

```json
  "version": "0.3.0",
```

- [ ] **Step 3: Verify both parse and report 0.3.0**

Run:

```bash
cargo metadata --no-deps --format-version 1 | tr ',' '\n' | grep -m1 '"version"'
grep -m1 '"version"' tauri.conf.json
```

Expected: both show `0.3.0`.

- [ ] **Step 4: Commit**

```bash
git add Cargo.toml tauri.conf.json
git commit -m "chore(release): set in-dev target version to 0.3.0"
```

---

## Task 3: Generalize `roll_nightly` → `roll_channel`

**Files:**
- Modify: `scripts/ci/gitea-release.sh`
- Modify: `.gitea/workflows/release.yml` (the one caller of `roll_nightly`)

`roll_nightly` is already tag-generic; only its name implies "nightly". Rename it so the stable pointer can reuse it without a misleading name. (No unit test — these functions hit the live Gitea API; they are exercised by the CI run.)

- [ ] **Step 1: Rename the function and its doc comment**

In `scripts/ci/gitea-release.sh`, replace the `roll_nightly` block (lines ~34-42):

```bash
# roll_nightly <tag> <name> <prerelease> <sha> — delete old release+tag, recreate; echoes new id.
# Gitea API quirk: deleting a release does NOT delete its tag, and re-creating a tag
# does NOT update an existing release — both must be deleted before recreating.
roll_nightly() {
  local id; id="$(release_id_for_tag "$1")"
  [ -n "$id" ] && delete_release "$id" || true
  delete_tag "$1"
  create_release "$1" "$2" "$3" "$4"
}
```

with:

```bash
# roll_channel <tag> <name> <prerelease> <sha> — delete old release+tag, recreate; echoes new id.
# Used for the rolling channel pointers ("nightly", "stable"). Gitea API quirk:
# deleting a release does NOT delete its tag, and re-creating a tag does NOT update
# an existing release — both must be deleted before recreating.
roll_channel() {
  local id; id="$(release_id_for_tag "$1")"
  [ -n "$id" ] && delete_release "$id" || true
  delete_tag "$1"
  create_release "$1" "$2" "$3" "$4"
}
```

- [ ] **Step 2: Update the caller in release.yml**

In `.gitea/workflows/release.yml`, in the "Create release + upload assets" step, change the nightly branch call from `roll_nightly` to `roll_channel`:

```bash
            ID="$(roll_channel "$TAG" "$RELEASE_NAME" true "$GITHUB_SHA")"
```

(This line is rewritten more substantially in Task 5; this step just keeps `master` green if Task 5 is deferred. If executing Tasks 3→5 back-to-back, this line will be replaced by Task 5 — that is fine.)

- [ ] **Step 3: Syntax-check the script**

Run:

```bash
bash -n scripts/ci/gitea-release.sh && echo "syntax OK"
```

Expected: `syntax OK`.

- [ ] **Step 4: Commit**

```bash
git add scripts/ci/gitea-release.sh .gitea/workflows/release.yml
git commit -m "refactor(ci): rename roll_nightly -> roll_channel for reuse"
```

---

## Task 4: Prerelease nightly version in the Compute step

**Files:**
- Modify: `.gitea/workflows/release.yml` ("Compute version + channel" step, lines ~57-69)

Adds the per-channel pointer/archive tags and the prerelease nightly version derived from `Cargo.toml`.

- [ ] **Step 1: Add a local derivation test (TDD for the version string)**

The version logic is shell, so prove it in isolation first. Run this exactly (it mimics the workflow's nightly branch):

```bash
TARGET="$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')"
RUN=42
VER="${TARGET}-nightly.${RUN}"
echo "$VER"
test "$VER" = "0.3.0-nightly.42" && echo "DERIVATION OK"
```

Expected: prints `0.3.0-nightly.42` then `DERIVATION OK`. (Requires Task 2 committed.)

- [ ] **Step 2: Replace the Compute step**

Replace the entire "Compute version + channel" step in `release.yml` with this. **Approach A (NSIS spike PASSED):**

```yaml
      - name: Compute version + channel
        id: v
        shell: bash
        run: |
          if [[ "${{ github.ref }}" == refs/tags/v* ]]; then
            VER="${{ github.ref_name }}"; VER="${VER#v}"
            { echo "version=$VER"; echo "pointer_tag=stable"; echo "archive_tag=v$VER";
              echo "name=v$VER"; echo "prerelease=false"; echo "channel=stable"; } >> "$GITHUB_OUTPUT"
          else
            # Nightly = prerelease of the committed in-dev target, so it sorts below
            # the eventual stable (0.3.0-nightly.41 < 0.3.0-nightly.42 < 0.3.0).
            TARGET="$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')"
            VER="${TARGET}-nightly.${{ github.run_number }}"
            { echo "version=$VER"; echo "pointer_tag=nightly"; echo "archive_tag=";
              echo "name=Nightly $VER"; echo "prerelease=true"; echo "channel=nightly"; } >> "$GITHUB_OUTPUT"
          fi
```

**Approach B (NSIS spike FAILED — numeric nightly instead):** identical EXCEPT the nightly `VER` line:

```yaml
            # Numeric nightly (NSIS rejected prerelease strings): the committed
            # target's minor is the nightly prefix; stable stays clean via tags.
            TARGET="$(grep -m1 '^version' Cargo.toml | sed -E 's/.*"([^"]+)".*/\1/')"
            MAJ_MIN="${TARGET%.*}"
            VER="${MAJ_MIN}.${{ github.run_number }}"
```

- [ ] **Step 3: Lint the workflow YAML**

Run (Python is available on the runner/dev box):

```bash
python -c "import yaml,sys; yaml.safe_load(open('.gitea/workflows/release.yml')); print('YAML OK')"
```

Expected: `YAML OK`. (If `python` is unavailable, use `python3`.)

- [ ] **Step 4: Commit**

```bash
git add .gitea/workflows/release.yml
git commit -m "feat(ci): nightly version is a prerelease of the committed target"
```

---

## Task 5: Per-channel pointer publishing + stable archive

**Files:**
- Modify: `.gitea/workflows/release.yml` ("Build latest.json" step ~106-121 and "Create release + upload assets" step ~123-145)

Make `latest.json` URLs point at the channel **pointer** tag, roll the pointer, and for stable also create the permanent `vX.Y.Z` archive.

- [ ] **Step 1: Point latest.json at the channel pointer tag**

Replace the "Build latest.json" step's `base=` line. The step currently uses `TAG='${{ steps.v.outputs.tag }}'`; that output no longer exists (Task 4 replaced it with `pointer_tag`/`archive_tag`). Replace the whole step with:

```yaml
      - name: Build latest.json
        shell: bash
        run: |
          VERSION='${{ steps.v.outputs.version }}'
          POINTER='${{ steps.v.outputs.pointer_tag }}'
          # latest.json asset URLs point at the rolling pointer release so they keep
          # working as it rolls (nightly or stable).
          base="${GITEA}/${REPO}/releases/download/${POINTER}"
          export VERSION
          PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          NOTES='${{ steps.v.outputs.name }}' \
          WIN_SIG_FILE="dist/xbox-remote_${VERSION}_x64-setup.exe.sig" \
          WIN_URL="${base}/xbox-remote_${VERSION}_x64-setup.exe" \
          LINUX_SIG_FILE="dist/xbox-remote_${VERSION}_amd64.AppImage.sig" \
          LINUX_URL="${base}/xbox-remote_${VERSION}_amd64.AppImage" \
          bash scripts/ci/make-latest-json.sh > dist/latest.json
          cat dist/latest.json
```

- [ ] **Step 2: Roll the pointer + archive stable**

Replace the "Create release + upload assets" step with:

```yaml
      - name: Create release + upload assets
        shell: bash
        run: |
          VERSION='${{ steps.v.outputs.version }}'
          POINTER='${{ steps.v.outputs.pointer_tag }}'
          ARCHIVE='${{ steps.v.outputs.archive_tag }}'
          RELEASE_NAME='${{ steps.v.outputs.name }}'
          PRERELEASE='${{ steps.v.outputs.prerelease }}'
          source scripts/ci/gitea-release.sh

          assets=(
            "xbox-remote_${VERSION}_x64-setup.exe"
            "xbox-remote_${VERSION}_x64-setup.exe.sig"
            "xbox-remote_${VERSION}_amd64.AppImage"
            "xbox-remote_${VERSION}_amd64.AppImage.sig"
          )

          # Always roll the channel pointer (nightly or stable) with binaries + latest.json.
          PID="$(roll_channel "$POINTER" "$RELEASE_NAME" "$PRERELEASE" "$GITHUB_SHA")"
          echo "pointer release id: $PID"
          for f in "${assets[@]}" "latest.json"; do
            upload_asset "$PID" "$f" "dist/$f"
          done

          # Stable also gets a permanent vX.Y.Z archive (binaries only; the pointer
          # holds the updater manifest).
          if [ -n "$ARCHIVE" ]; then
            AID="$(create_release "$ARCHIVE" "$RELEASE_NAME" false "$GITHUB_SHA")"
            echo "archive release id: $AID"
            for f in "${assets[@]}"; do
              upload_asset "$AID" "$f" "dist/$f"
            done
          fi
```

- [ ] **Step 3: Lint the workflow YAML**

Run:

```bash
python -c "import yaml,sys; yaml.safe_load(open('.gitea/workflows/release.yml')); print('YAML OK')"
```

Expected: `YAML OK`.

- [ ] **Step 4: Commit**

```bash
git add .gitea/workflows/release.yml
git commit -m "feat(ci): publish per-channel pointer + stable archive"
```

---

## Task 6: Prerelease test case for make-latest-json

**Files:**
- Modify: `scripts/ci/make-latest-json.test.sh`

`make-latest-json.sh` passes `VERSION` through `jq --arg` (a string), so a prerelease value already works — lock it with a test.

- [ ] **Step 1: Add the failing/locking test case**

In `scripts/ci/make-latest-json.test.sh`, immediately before the final `echo "PASS"` line, add:

```bash
# ── Case 4: prerelease version is emitted verbatim ──────────────────────────────
out4="$(VERSION=0.3.0-nightly.42 NOTES='n' PUB_DATE=2026-06-09T00:00:00Z \
  WIN_SIG_FILE="$tmp/win.sig" WIN_URL='https://h/win.exe' \
  LINUX_SIG_FILE="$tmp/linux.sig" LINUX_URL='https://h/app.AppImage' \
  bash make-latest-json.sh)"
echo "$out4" | jq -e '.version=="0.3.0-nightly.42"' >/dev/null
```

- [ ] **Step 2: Run the test suite**

Run:

```bash
bash scripts/ci/make-latest-json.test.sh
```

Expected: `PASS` (all four cases). If `jq` treated the prerelease specially it would fail here — it does not, because `--arg` forces a string.

- [ ] **Step 3: Commit**

```bash
git add scripts/ci/make-latest-json.test.sh
git commit -m "test(ci): assert prerelease version passes through latest.json verbatim"
```

---

## Task 7: Document the scheme

**Files:**
- Modify: `docs/RELEASES.md`
- Modify: `CLAUDE.md` (Releases & Auto-Update section, ~line 78-90)

- [ ] **Step 1: Read the current docs to find the version-scheme text**

Run:

```bash
sed -n '1,80p' docs/RELEASES.md
```

Locate the section describing nightly version `0.1.<run_number>` and the channels.

- [ ] **Step 2: Update `docs/RELEASES.md`**

Replace the version-scheme description with the new model. Add (or replace the equivalent existing paragraph with) this text:

```markdown
## Versioning

- **Committed version** (`Cargo.toml`, `tauri.conf.json`) is the in-development
  **target** — the next unreleased `X.Y.Z` (currently `0.3.0`).
- **Nightly** (every push to `master`): `X.Y.Z-nightly.<run_number>` — a semver
  prerelease of the target, so nightlies sort below the eventual stable
  (`0.3.0-nightly.41 < 0.3.0-nightly.42 < 0.3.0`). Published to the rolling
  `nightly` release.
- **Stable** (push a `vX.Y.Z` tag): clean `X.Y.Z` from the tag. Published to BOTH
  the permanent `vX.Y.Z` archive release AND the rolling `stable` pointer.
- **After cutting a stable `vX.Y.Z`**, bump the committed version to the next
  target so subsequent nightlies stay ahead.

## Channels

Two rolling pointer releases hold the updater manifests:
- `…/releases/download/nightly/latest.json`
- `…/releases/download/stable/latest.json`

(The in-app channel selector that chooses between them is a separate change.)
```

- [ ] **Step 3: Update `CLAUDE.md`**

In `CLAUDE.md`, in the "Releases & Auto-Update (CI/CD)" section, replace the nightly bullet text that says `Version = 0.1.<run_number>, injected via --config (the committed version stays 0.1.0).` with:

```markdown
  Nightly version = `<target>-nightly.<run_number>` where `<target>` is the committed
  `Cargo.toml` version (the next unreleased `X.Y.Z`); injected via `--config` so the
  tree stays clean. Stable (`vX.Y.Z` tag) = clean version from the tag, published to
  BOTH the permanent `vX.Y.Z` archive and the rolling `stable` pointer. After cutting
  a stable, bump the committed target. Both channels expose a rolling
  `…/releases/download/{nightly,stable}/latest.json`.
```

- [ ] **Step 4: Commit**

```bash
git add docs/RELEASES.md CLAUDE.md
git commit -m "docs: document prerelease nightly + dual-channel publishing"
```

---

## Task 8: Final verification

**Files:** none (verification only).

- [ ] **Step 1: Re-run all CI script tests**

```bash
bash scripts/ci/make-latest-json.test.sh
bash -n scripts/ci/gitea-release.sh && echo "gitea-release syntax OK"
python -c "import yaml; yaml.safe_load(open('.gitea/workflows/release.yml')); print('YAML OK')"
```

Expected: `PASS`, `gitea-release syntax OK`, `YAML OK`.

- [ ] **Step 2: Confirm no stale `roll_nightly` / `outputs.tag` references remain**

```bash
grep -rn "roll_nightly\|steps.v.outputs.tag\b" .gitea scripts || echo "no stale references"
```

Expected: `no stale references`.

- [ ] **Step 3: Confirm version files**

```bash
grep -m1 '^version' Cargo.toml; grep -m1 '"version"' tauri.conf.json
```

Expected: both `0.3.0`.

- [ ] **Step 4: Live CI verification (after merge)**

Documented, not automatable here:
- A push to `master` produces a nightly release versioned `0.3.0-nightly.<run>` (Approach A) or `0.3.<run>` (Approach B), with `nightly/latest.json` carrying that version.
- A `vX.Y.Z` tag produces a clean `vX.Y.Z` permanent archive AND updates the `stable` rolling pointer, whose `stable/latest.json` carries `X.Y.Z`.

---

## Self-Review Notes

- **Spec coverage:** Goal 1 (clean stable) → Task 4 stable branch + Task 5 archive; Goal 2 (prerelease nightly) → Task 4 (gated by Task 1); Goal 3 (stable pointer) → Tasks 3+5; Goal 4 (monotonic per channel) → Task 4 version scheme. NSIS open risk → Task 1. `make-latest-json` prerelease → Task 6. Docs → Task 7. Lifecycle (post-tag bump) → documented in Task 7. All covered.
- **Type/identifier consistency:** the Compute step emits `version`, `pointer_tag`, `archive_tag`, `name`, `prerelease`, `channel`; Tasks 5 reads exactly those (`pointer_tag`, `archive_tag`, `prerelease`, `version`, `name`). The old `tag`/`channel`-branch logic is fully replaced (verified by Task 8 Step 2 grep). `roll_channel` defined in Task 3, used in Task 5.
- **No placeholders:** every step has exact commands/code.
- **Approach A/B:** Task 1 decides; Task 4 spells out both nightly `VER=` variants; all other tasks are identical for both.
