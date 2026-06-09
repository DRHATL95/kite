# Windows Installer Implementation Plan

> **For Claude:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task.

**Goal:** Enable a repeatable Windows setup `.exe` installer for Xbox Remote.

**Architecture:** Use Tauri v2's built-in NSIS bundler from the existing root-level Tauri configuration. Keep development builds unchanged while adding a documented release workflow that builds `ui/dist` before bundling the Rust app.

**Tech Stack:** Rust 2024, Tauri v2, Svelte 5, Vite, NSIS via Tauri bundler.

---

### Task 1: Enable Tauri Bundling

**Files:**
- Modify: `tauri.conf.json`

**Step 1: Inspect current bundle configuration**

Run: `Get-Content -Path tauri.conf.json`

Expected: `bundle.active` is `false`.

**Step 2: Update bundle settings**

Change the bundle block so it enables NSIS:

```json
"bundle": {
  "active": true,
  "targets": ["nsis"],
  "icon": [
    "icons/icon.ico",
    "icons/icon.png"
  ],
  "windows": {
    "certificateThumbprint": null,
    "digestAlgorithm": "sha256",
    "timestampUrl": "",
    "webviewInstallMode": {
      "type": "downloadBootstrapper"
    },
    "nsis": {
      "installerIcon": "icons/icon.ico",
      "installMode": "perMachine",
      "displayLanguageSelector": false
    }
  }
}
```

**Step 3: Validate JSON**

Run: `node -e "JSON.parse(require('fs').readFileSync('tauri.conf.json','utf8')); console.log('valid json')"`

Expected: `valid json`.

### Task 2: Document Installer Workflow

**Files:**
- Modify: `README.md`
- Modify: `CLAUDE.md`

**Step 1: Add README installer section**

Add a distribution section that includes:

```powershell
npm --prefix ui install
npm --prefix ui run build
cargo tauri build
```

State that the NSIS installer is emitted under:

```text
target\x86_64-pc-windows-msvc\release\bundle\nsis\
```

**Step 2: Add CLAUDE.md release command notes**

Document the same root-level workflow and keep the existing warning that frontend assets must be rebuilt before Tauri embeds them.

### Task 3: Verify

**Files:**
- No source changes expected.

**Step 1: Run frontend checks**

Run: `npm --prefix ui run check`

Expected: succeeds.

**Step 2: Run frontend tests**

Run: `npm --prefix ui run test`

Expected: succeeds.

**Step 3: Build frontend**

Run: `npm --prefix ui run build`

Expected: writes `ui/dist`.

**Step 4: Run Rust tests**

Run: `cargo test`

Expected: succeeds.

**Step 5: Build installer**

Run: `cargo tauri build`

Expected: creates an NSIS setup executable under `target\x86_64-pc-windows-msvc\release\bundle\nsis\`.
