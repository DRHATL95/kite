# Gitea Actions Release Workflow (Sub-project 2) — Implementation Plan

> **DESCOPED 2026-06-10 (owner decision):** releases ship the **Windows exe only** for now;
> Linux users clone + build from source. The `build-linux` job (Task 5) is NOT implemented and
> `make-latest-json.sh` emits only a `windows-x86_64` platform entry. The Linux runner still
> executes the `setup` and `publish` jobs. To add Linux later: implement Task 5 and add the
> linux entry back to the manifest script.

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (or executing-plans) to implement task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** A `.gitea/workflows/release.yml` that, on every push to `master`, builds signed Windows + Linux installers and publishes them (plus a Tauri `latest.json` updater manifest) to a rolling **nightly** Gitea release — and on a `v*` tag, cuts a permanent **stable** release.

**Architecture:** Three jobs. `build-windows` (host runner, label `windows`) → NSIS `-setup.exe` + `.sig`. `build-linux` (runner label `linux`) → AppImage + `.sig`. `publish` (`needs: [build-windows, build-linux]`) downloads both jobs' artifacts, assembles a single `latest.json`, and creates/updates the Gitea release via the **REST API (curl)** using the built-in `GITEA_TOKEN`. Version is injected at build time via Tauri's `--config` merge-patch; the source `version` stays `0.1.0`.

**Tech Stack:** Gitea Actions (GitHub-Actions-compatible YAML), `cargo tauri build`, curl + Gitea REST API, `jq`.

**Reference:** Design spec §4 (`docs/superpowers/specs/2026-06-09-auto-update-cicd-design.md`). Sub-project 1 already shipped the app-side updater (endpoint `https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/latest.json`, embedded pubkey, `createUpdaterArtifacts:true`, bundle targets `nsis`+`appimage`).

**Branch:** continue on `auto-update-cicd` (or a fresh branch off it).

---

## Key decisions (researched 2026-06-09)
- **No `tauri-action`.** Its Gitea compatibility is unverified; we hand-roll the build and publish via the Gitea REST API (which we already used to cut v0.1.0 — known-good).
- **Auth:** built-in token, exposed as `${{ secrets.GITEA_TOKEN }}` / `${{ github.token }}`. Add `permissions: { contents: write }` (covers Restricted mode). No PAT needed (same-repo releases).
- **Runners:** `runs-on: windows` (host runner — MSVC/WebView2/NSIS) and `runs-on: linux` (sub-project 3 provisions it with Rust + Node + Tauri Linux deps + AppImage tooling pre-installed). These labels are created in sub-project 3.
- **Version injection:** `cargo tauri build --config '{"version":"<v>"}'` (Tauri 2 top-level `version` key; non-destructive). Nightly `v = 0.1.${{ github.run_number }}`; stable `v = <tag without leading 'v'>`.
- **Channels / triggers:** `on: push` to `master` → nightly (rolling tag `nightly`, `prerelease:true`); `on: push` of tag `v*` → stable (permanent release `vX.Y.Z`).
- **Nightly is rolling:** the publish job deletes the old `nightly` release + tag, then recreates on the current SHA, so releases don't accumulate. (Gitea API: deleting a release does NOT delete its tag, and recreating a tag does NOT update an existing release — so delete BOTH, then recreate.)
- **Asset names are space-free.** Tauri emits `Xbox Remote_<v>_x64-setup.exe` (a space → `%20` in URLs). On upload, set the Gitea asset `?name=` to a space-free name (e.g. `xbox-remote_<v>_x64-setup.exe`); `latest.json` URLs point at those names. Signatures are over file BYTES, so renaming the asset doesn't invalidate the `.sig`.
- **`latest.json` schema (Tauri v2 static manifest):**
  ```json
  {
    "version": "0.1.42",
    "notes": "Nightly build 0.1.42",
    "pub_date": "2026-06-09T00:00:00Z",
    "platforms": {
      "windows-x86_64": { "signature": "<contents of the windows .sig>", "url": "https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/xbox-remote_0.1.42_x64-setup.exe" },
      "linux-x86_64":   { "signature": "<contents of the linux .sig>",   "url": "https://gitea.howlab.co/dave/xbox-remote/releases/download/nightly/xbox-remote_0.1.42_amd64.AppImage" }
    }
  }
  ```
  `signature` = the literal text inside the `.sig` file. `url` = the downloadable asset URL on the release (must match the uploaded asset name and the channel tag, `nightly` or `vX.Y.Z`).

## Prerequisites the OWNER must satisfy before this workflow can RUN (sub-project 3 + secrets)
- Gitea Actions enabled for the repo; runners online with labels `windows` (host) and `linux`.
- Repo Actions secrets: `TAURI_SIGNING_PRIVATE_KEY` (contents of `~/.tauri/xbox-remote-updater.key`) and `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` (empty string).
- Confirm Actions permission mode isn't admin-locked to Restricted with a low max (else `permissions: contents: write` is clamped).

> **Validation reality:** this sub-project produces YAML + scripts that can be **lint-checked** here (`actionlint`, `yamllint`, `jq` dry-runs of the latest.json builder) but cannot be **executed** until sub-project 3's runners exist + secrets are set. End-to-end run is owner-verified, like streaming.

---

## File structure
- Create `.gitea/workflows/release.yml` — the pipeline (3 jobs).
- Create `scripts/ci/make-latest-json.sh` — assembles `latest.json` from per-platform `{version, signature-file, url}` inputs (kept as a script so it's unit-testable with `jq`, not buried in YAML).
- Create `scripts/ci/gitea-release.sh` — helper functions for the Gitea REST API (get-release-by-tag, delete-release, delete-tag, create-release, upload-asset), sourced by the publish job. Keeps curl logic testable + out of the YAML.

---

## Task 1: Release-helper script (Gitea REST API)

**Files:** Create `scripts/ci/gitea-release.sh`.

- [ ] **Step 1: Write `scripts/ci/gitea-release.sh`** — POSIX `sh`/`bash` functions using curl + `jq`. Reads `GITEA` (base URL), `REPO` (`dave/xbox-remote`), `TOKEN` from env. Functions:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${GITEA:?}"; : "${REPO:?}"; : "${TOKEN:?}"
AUTH="Authorization: token ${TOKEN}"
API="${GITEA}/api/v1/repos/${REPO}"

# echo the release id for a tag, or empty string if none (404)
release_id_for_tag() {
  curl -fsS -H "$AUTH" "${API}/releases/tags/$1" 2>/dev/null | jq -r '.id // empty'
}
delete_release() { curl -fsS -X DELETE -H "$AUTH" "${API}/releases/$1"; }
delete_tag()     { curl -fsS -X DELETE -H "$AUTH" "${API}/tags/$1" || true; }

# create_release <tag> <name> <prerelease:true|false> <target_sha> -> echoes new id
create_release() {
  curl -fsS -X POST -H "$AUTH" -H "Content-Type: application/json" "${API}/releases" \
    -d "$(jq -nc --arg t "$1" --arg n "$2" --argjson pre "$3" --arg c "$4" \
          '{tag_name:$t,name:$n,prerelease:$pre,target_commitish:$c,draft:false}')" \
    | jq -r '.id'
}
# upload_asset <release_id> <asset_name> <file_path>
upload_asset() {
  curl -fsS -X POST -H "$AUTH" \
    "${API}/releases/$1/assets?name=$(jq -rn --arg s "$2" '$s|@uri')" \
    -F "attachment=@$3"
}
# roll_nightly <tag> <name> <prerelease> <sha> -> deletes old release+tag, recreates, echoes new id
roll_nightly() {
  local id; id="$(release_id_for_tag "$1")"
  [ -n "$id" ] && delete_release "$id" || true
  delete_tag "$1"
  create_release "$1" "$2" "$3" "$4"
}
```
- [ ] **Step 2: Lint** — `bash -n scripts/ci/gitea-release.sh` (syntax) and `shellcheck scripts/ci/gitea-release.sh` if available (fix warnings). Confirm functions parse.
- [ ] **Step 3: Commit** — `git add scripts/ci/gitea-release.sh && git commit -m "ci(release): Gitea REST API release helpers (create/roll/upload)"`

---

## Task 2: `latest.json` assembler + its test

**Files:** Create `scripts/ci/make-latest-json.sh`; Create `scripts/ci/make-latest-json.test.sh`.

- [ ] **Step 1: Write the test first** (`make-latest-json.test.sh`) — feeds known inputs and asserts the JSON shape with `jq`:
```bash
#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")"
tmp="$(mktemp -d)"; printf 'WINSIG' > "$tmp/win.sig"; printf 'LINSIG' > "$tmp/lin.sig"
out="$(VERSION=0.1.42 NOTES='n' PUB_DATE=2026-06-09T00:00:00Z \
  WIN_SIG_FILE="$tmp/win.sig" WIN_URL='https://h/win.exe' \
  LIN_SIG_FILE="$tmp/lin.sig" LIN_URL='https://h/lin.AppImage' \
  ./make-latest-json.sh)"
echo "$out" | jq -e '.version=="0.1.42"' >/dev/null
echo "$out" | jq -e '.platforms["windows-x86_64"].signature=="WINSIG"' >/dev/null
echo "$out" | jq -e '.platforms["windows-x86_64"].url=="https://h/win.exe"' >/dev/null
echo "$out" | jq -e '.platforms["linux-x86_64"].signature=="LINSIG"' >/dev/null
echo "PASS"
```
- [ ] **Step 2: Run it, expect FAIL** — `bash scripts/ci/make-latest-json.test.sh` → fails (script doesn't exist yet).
- [ ] **Step 3: Write `make-latest-json.sh`** — reads env, emits the manifest to stdout via `jq`:
```bash
#!/usr/bin/env bash
set -euo pipefail
: "${VERSION:?}"; : "${PUB_DATE:?}"
: "${WIN_SIG_FILE:?}"; : "${WIN_URL:?}"; : "${LIN_SIG_FILE:?}"; : "${LIN_URL:?}"
jq -nc \
  --arg v "$VERSION" --arg notes "${NOTES:-}" --arg date "$PUB_DATE" \
  --arg wsig "$(cat "$WIN_SIG_FILE")" --arg wurl "$WIN_URL" \
  --arg lsig "$(cat "$LIN_SIG_FILE")" --arg lurl "$LIN_URL" \
  '{version:$v, notes:$notes, pub_date:$date,
    platforms:{ "windows-x86_64":{signature:$wsig,url:$wurl},
                "linux-x86_64":{signature:$lsig,url:$lurl} }}'
```
- [ ] **Step 4: Run the test, expect PASS** — `bash scripts/ci/make-latest-json.test.sh` → `PASS`.
- [ ] **Step 5: Commit** — `git add scripts/ci/make-latest-json.sh scripts/ci/make-latest-json.test.sh && git commit -m "ci(release): latest.json assembler + jq test"`

---

## Task 3: Workflow skeleton — triggers + version computation

**Files:** Create `.gitea/workflows/release.yml`.

- [ ] **Step 1: Write the workflow header + a `setup` job** that computes channel, version, tag, and prerelease flag once, and exposes them as outputs:
```yaml
name: release
on:
  push:
    branches: [master]
    tags: ['v*']
permissions:
  contents: write
jobs:
  setup:
    runs-on: linux
    outputs:
      version: ${{ steps.v.outputs.version }}
      tag: ${{ steps.v.outputs.tag }}
      name: ${{ steps.v.outputs.name }}
      prerelease: ${{ steps.v.outputs.prerelease }}
      channel: ${{ steps.v.outputs.channel }}
    steps:
      - id: v
        shell: bash
        run: |
          if [[ "${{ github.ref }}" == refs/tags/v* ]]; then
            VER="${{ github.ref_name }}"; VER="${VER#v}"
            { echo "version=$VER"; echo "tag=v$VER"; echo "name=v$VER";
              echo "prerelease=false"; echo "channel=stable"; } >> "$GITHUB_OUTPUT"
          else
            VER="0.1.${{ github.run_number }}"
            { echo "version=$VER"; echo "tag=nightly"; echo "name=Nightly $VER";
              echo "prerelease=true"; echo "channel=nightly"; } >> "$GITHUB_OUTPUT"
          fi
```
- [ ] **Step 2: Lint** — `actionlint .gitea/workflows/release.yml` (install if needed) OR `yamllint`. Confirm the expressions parse and `$GITHUB_OUTPUT` usage is valid. (Expected: clean, or only style warnings.)
- [ ] **Step 3: Commit** — `git add .gitea/workflows/release.yml && git commit -m "ci(release): workflow triggers + version/channel setup job"`

---

## Task 4: build-windows job

**Files:** Modify `.gitea/workflows/release.yml`.

- [ ] **Step 1: Add the `build-windows` job** (`needs: setup`, `runs-on: windows`, host runner). It checks out, sets up Node + Rust (assume Rust/Node present on the host runner from sub-project 3; otherwise the `setup-*` actions install them), builds the frontend, kills any stale app instance (the verified `Access is denied` gotcha), then runs the signed Tauri build with the injected version, and uploads the artifacts:
```yaml
  build-windows:
    needs: setup
    runs-on: windows
    defaults: { run: { shell: pwsh } }
    env:
      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Build frontend
        run: npm --prefix ui ci; npm --prefix ui run build
      - name: Kill any stale app instance (avoids 'Access is denied' on the exe)
        run: Get-Process xbox-remote -ErrorAction SilentlyContinue | Stop-Process -Force; exit 0
      - name: Tauri build (signed, NSIS)
        run: cargo tauri build --bundles nsis --config ('{\"version\":\"' + '${{ needs.setup.outputs.version }}' + '\"}')
      - name: Stage artifacts (space-free names)
        run: |
          $v = '${{ needs.setup.outputs.version }}'
          New-Item -ItemType Directory -Force out | Out-Null
          Copy-Item "target/release/bundle/nsis/Xbox Remote_${v}_x64-setup.exe"     "out/xbox-remote_${v}_x64-setup.exe"
          Copy-Item "target/release/bundle/nsis/Xbox Remote_${v}_x64-setup.exe.sig" "out/xbox-remote_${v}_x64-setup.exe.sig"
      - uses: actions/upload-artifact@v4
        with: { name: windows, path: out/* }
```
- [ ] **Step 2: Lint** — `actionlint`/`yamllint` clean (mind the PowerShell `--config` quoting; an alternative is to write the JSON to a file and pass `--config ci.version.json`). Verify the `--config` expression is valid PowerShell.
- [ ] **Step 3: Commit** — `git add .gitea/workflows/release.yml && git commit -m "ci(release): build-windows job (signed NSIS + space-free artifacts)"`

---

## Task 5: build-linux job

**Files:** Modify `.gitea/workflows/release.yml`.

- [ ] **Step 1: Add the `build-linux` job** (`needs: setup`, `runs-on: linux`). Assumes the runner (sub-project 3) has Rust + Node + Tauri Linux deps (`libwebkit2gtk-4.1-dev libgtk-3-dev libayatana-appindicator3-dev librsvg2-dev patchelf` + AppImage tooling). Builds the AppImage signed, stages space-free artifacts:
```yaml
  build-linux:
    needs: setup
    runs-on: linux
    env:
      TAURI_SIGNING_PRIVATE_KEY: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY }}
      TAURI_SIGNING_PRIVATE_KEY_PASSWORD: ${{ secrets.TAURI_SIGNING_PRIVATE_KEY_PASSWORD }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/setup-node@v4
        with: { node-version: '20' }
      - name: Build frontend
        run: npm --prefix ui ci && npm --prefix ui run build
      - name: Tauri build (signed, AppImage)
        run: cargo tauri build --bundles appimage --config '{"version":"${{ needs.setup.outputs.version }}"}'
      - name: Stage artifacts (space-free names)
        run: |
          v='${{ needs.setup.outputs.version }}'
          mkdir -p out
          # Tauri AppImage name varies by version/arch; copy the produced files generically:
          cp target/release/bundle/appimage/*.AppImage     "out/xbox-remote_${v}_amd64.AppImage"
          cp target/release/bundle/appimage/*.AppImage.sig  "out/xbox-remote_${v}_amd64.AppImage.sig"
      - uses: actions/upload-artifact@v4
        with: { name: linux, path: out/* }
```
- [ ] **Step 2: Lint** — `actionlint`/`yamllint` clean. (Note: AppImage filename/casing produced by Tauri can vary; the generic `*.AppImage` copy avoids hardcoding. If multiple AppImages exist the copy must select the right one — acceptable for a single-bundle build.)
- [ ] **Step 3: Commit** — `git add .gitea/workflows/release.yml && git commit -m "ci(release): build-linux job (signed AppImage + space-free artifacts)"`

---

## Task 6: publish job (assemble latest.json + create/roll release + upload)

**Files:** Modify `.gitea/workflows/release.yml`.

- [ ] **Step 1: Add the `publish` job** (`needs: [setup, build-windows, build-linux]`, `runs-on: linux`). Downloads both artifacts, builds `latest.json` via the Task-2 script, then (nightly) rolls the release or (stable) creates it via the Task-1 helpers, and uploads all assets + `latest.json`:
```yaml
  publish:
    needs: [setup, build-windows, build-linux]
    runs-on: linux
    env:
      GITEA: https://gitea.howlab.co
      REPO: dave/xbox-remote
      TOKEN: ${{ secrets.GITEA_TOKEN }}
      VERSION: ${{ needs.setup.outputs.version }}
      TAG: ${{ needs.setup.outputs.tag }}
      NAME: ${{ needs.setup.outputs.name }}
      PRERELEASE: ${{ needs.setup.outputs.prerelease }}
      CHANNEL: ${{ needs.setup.outputs.channel }}
    steps:
      - uses: actions/checkout@v4
      - uses: actions/download-artifact@v4
        with: { name: windows, path: dist }
      - uses: actions/download-artifact@v4
        with: { name: linux, path: dist }
      - name: Build latest.json
        shell: bash
        run: |
          base="${GITEA}/${REPO}/releases/download/${TAG}"
          PUB_DATE="$(date -u +%Y-%m-%dT%H:%M:%SZ)" \
          NOTES="${NAME}" \
          WIN_SIG_FILE="dist/xbox-remote_${VERSION}_x64-setup.exe.sig" \
          WIN_URL="${base}/xbox-remote_${VERSION}_x64-setup.exe" \
          LIN_SIG_FILE="dist/xbox-remote_${VERSION}_amd64.AppImage.sig" \
          LIN_URL="${base}/xbox-remote_${VERSION}_amd64.AppImage" \
          bash scripts/ci/make-latest-json.sh > dist/latest.json
          cat dist/latest.json
      - name: Create/roll release + upload assets
        shell: bash
        run: |
          source scripts/ci/gitea-release.sh
          if [ "$CHANNEL" = nightly ]; then
            ID="$(roll_nightly "$TAG" "$NAME" true "$GITHUB_SHA")"
          else
            ID="$(create_release "$TAG" "$NAME" false "$GITHUB_SHA")"
          fi
          for f in \
            "xbox-remote_${VERSION}_x64-setup.exe" \
            "xbox-remote_${VERSION}_x64-setup.exe.sig" \
            "xbox-remote_${VERSION}_amd64.AppImage" \
            "xbox-remote_${VERSION}_amd64.AppImage.sig" \
            "latest.json"; do
            upload_asset "$ID" "$f" "dist/$f"
          done
```
- [ ] **Step 2: Lint** — `actionlint`/`yamllint` clean. Dry-run the latest.json step locally with fake sig files to confirm the URL base + names line up with what the build jobs upload (the `${TAG}` in the URL must equal the release tag — `nightly` or `vX.Y.Z`).
- [ ] **Step 3: Commit** — `git add .gitea/workflows/release.yml && git commit -m "ci(release): publish job — latest.json + create/roll release + upload"`

---

## Task 7: Local validation pass (lint + jq dry-runs)

- [ ] **Step 1:** Run `actionlint .gitea/workflows/release.yml` (and `yamllint`) — fix any real errors (expression syntax, job deps, shell quoting). Style-only warnings may remain.
- [ ] **Step 2:** Run `bash scripts/ci/make-latest-json.test.sh` → `PASS`; `bash -n scripts/ci/gitea-release.sh` (and shellcheck) clean.
- [ ] **Step 3:** Manually trace the artifact-name contract end-to-end: the names the build jobs `Copy-Item`/`cp` to → the artifact upload/download → the `latest.json` URLs → the `upload_asset` loop. They MUST all use the identical `xbox-remote_<v>_…` names. Fix any mismatch.
- [ ] **Step 4: Commit** any fixes — `git add -p` the workflow/scripts (explicit staging) and commit.

---

## Final verification (sub-project 2)
- [ ] `.gitea/workflows/release.yml` lints clean; 4 jobs (`setup`, `build-windows`, `build-linux`, `publish`) with correct `needs` + `runs-on` labels.
- [ ] Version injected via `--config` (nightly `0.1.<run_number>`, stable from tag); source `version` untouched.
- [ ] `latest.json` assembler is tested (`make-latest-json.test.sh` passes) and emits the Tauri v2 schema with both platforms; signatures read from `.sig` files; URLs use space-free asset names + the right channel tag.
- [ ] Publish uses the built-in `GITEA_TOKEN` + `permissions: contents: write`; nightly rolls (delete release+tag → recreate), stable creates a permanent release.
- [ ] Signing env wired from secrets in BOTH build jobs.
- [ ] Documented prerequisites (runners + secrets) called out for the owner.

> **End-to-end run is owner-verified** once sub-project 3's runners are online + secrets set: push to `master` → nightly release with installers + `latest.json` → an installed app prompts to update on next launch. (Can't be exercised here without the runners.)
