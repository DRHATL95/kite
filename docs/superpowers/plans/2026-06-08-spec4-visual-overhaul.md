# Spec 4 — Visual Overhaul — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax.

**Goal:** Re-skin the existing Svelte 5 frontend to the locked minimal "pro-tool" aesthetic in the Carbon + Green palette, with a Player-default stream view + one-key Stage focus mode, a restyled console picker, auth, and diagnostics HUD.

**Architecture:** Pure visual layer. Replace `ui/src/lib/design/tokens.css` with the locked tokens (single source of truth), then restyle the existing base components, screens, and HUD to reference only tokens. NO streaming/protocol/store/behavior changes — components keep their props and store wiring; only markup/styles change.

**Tech Stack:** Svelte 5 + TypeScript + Vite + CSS custom properties.

**Reference:** Spec `docs/superpowers/specs/2026-06-08-spec4-visual-overhaul-design.md` — esp. §2 (palette + semantic color rule), §3 (typography), §5 (per-screen treatment). That spec is the authoritative visual description.

**Branch:** `spec4-visual-overhaul` (checked out; spec committed here).

**Granularity note:** Task 1 pins COMPLETE `tokens.css` (exact values are the decision). Other tasks give the structural CSS + reference spec §5 for each screen's treatment; implementers write the Svelte markup/styles against the tokens. Every task ends with `npm --prefix ui run check` (0 errors) + `npm --prefix ui run build`, a visual review, and a commit.

**Git rule (all tasks):** explicit staging only — the tree has unrelated noise (`gen/schemas/*.json`, `.claude/`, `*.sh`, `.superpowers/`). Never `git add -A`.

**Semantic color rule (apply everywhere):** `--accent` (green) = good/active/healthy ONLY. `--warn` (amber) and `--bad` (red) = trouble ONLY (loss/jitter over threshold, freezes, `fallback-only`, reconnecting/failed, disconnect). Dim = labels/secondary. Never use accent for a merely-neutral element.

**Visual verification (how to "see" it):** `npm --prefix ui run dev` serves the UI at http://localhost:1420 in a plain browser (Tauri `invoke` calls fail there, so data is empty/error — that's fine for checking layout/style). Use a browser to screenshot each screen and compare to spec §5 + the semantic rule. Data-dependent screens (ConsoleList, Stream, HUD) can be verified by temporarily rendering with mock data (the HUD already has `ui/src/components/hud/mockSnapshot.ts`).

---

## Task 1: Design tokens + global frame

**Files:** Replace `ui/src/lib/design/tokens.css`; verify `ui/src/main.ts` imports it; set base styles in `ui/src/App.svelte`.

- [ ] **Step 1:** Replace the entire contents of `ui/src/lib/design/tokens.css` with:
```css
:root {
  /* Carbon + Green — single source of truth. No hex outside this file. */
  --bg: #0d0f0d;
  --surface: #161916;
  --surface-2: #1d211d;
  --border: #242824;
  --text-dim: #7e857e;
  --text: #e8ece8;
  --accent: #43c463;        /* good / active / healthy ONLY */
  --accent-press: #2f8f47;  /* pressed accent */
  --warn: #e0b341;          /* trouble */
  --bad: #d4685f;           /* trouble */

  --font-sans: system-ui, "Segoe UI", Roboto, sans-serif;
  --font-mono: ui-monospace, "Cascadia Code", "Cascadia Mono", Menlo, Consolas, monospace;

  --text-xs: 11px; --text-sm: 12px; --text-base: 14px; --text-lg: 17px; --text-xl: 22px;
  --space-1: 4px; --space-2: 8px; --space-3: 12px; --space-4: 16px; --space-5: 24px; --space-6: 32px;
  --radius-sm: 4px; --radius-md: 8px; --radius-lg: 12px;
  --shadow-sm: 0 1px 2px rgba(0,0,0,.4);
  --shadow-md: 0 6px 18px rgba(0,0,0,.45);
  --focus-ring: 0 0 0 2px rgba(67,196,99,.5);
}
* { box-sizing: border-box; }
html, body { margin: 0; height: 100%; }
body { background: var(--bg); color: var(--text); font-family: var(--font-sans); font-size: var(--text-base); }
:focus-visible { outline: none; box-shadow: var(--focus-ring); }
```
- [ ] **Step 2:** Confirm `ui/src/main.ts` imports the tokens (`import "./lib/design/tokens.css";`). Add it if missing.
- [ ] **Step 3:** In `ui/src/App.svelte`, ensure the root container fills the viewport on `--bg` (`height:100vh; background:var(--bg); color:var(--text);`).
- [ ] **Step 4:** `npm --prefix ui run check` (0 errors), `npm --prefix ui run build`. Visually: `npm --prefix ui run dev`, screenshot the shell — confirm the new dark carbon background + text color.
- [ ] **Step 5:** Commit: `git add ui/src/lib/design/tokens.css ui/src/main.ts ui/src/App.svelte && git commit -m "feat(ui): Carbon+Green design tokens + global frame"`

---

## Task 2: Restyle base components

**Files:** Modify `ui/src/lib/design/{Button,Panel,Stat,Toggle,Badge}.svelte`.

- [ ] **Step 1:** `Button.svelte` — variants: `primary` (bg `--accent`, text `#06120a`, hover slightly brighter, active `--accent-press`), `ghost` (transparent, `--border`, text `--text-dim`→`--text` on hover), `danger` (text/border `--bad`). Sans font; `--radius-sm`; `--space-2`/`--space-3` padding; disabled = reduced opacity + not-allowed.
- [ ] **Step 2:** `Panel.svelte` — `--surface` bg, `1px solid --border`, `--radius-lg`; optional title row (dim, mono, letter-spaced) with a hairline divider; slot/`headerRight` snippet preserved.
- [ ] **Step 3:** `Stat.svelte` — mono; `label` in `--text-dim` (uppercase, `--text-xs`), `value` in `--text` (or tone color); add an optional `tone: "good"|"warn"|"bad"|"neutral"` prop mapping to `--accent`/`--warn`/`--bad`/`--text`. Keep the existing prop names; `tone` is additive.
- [ ] **Step 4:** `Toggle.svelte` — track `--border`→`--accent` when on; knob `--text`; keep `$bindable` checked.
- [ ] **Step 5:** `Badge.svelte` — tone→token map: `good`=`--accent`, `warn`=`--warn`, `bad`=`--bad`, `neutral`=`--text-dim`; outlined style (1px tone border, tone text, transparent or faint tinted bg via `color-mix`), mono, `--text-xs`, `--radius-sm`.
- [ ] **Step 6:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run test` (still pass) + `npm --prefix ui run build`. Visual: render the components on a screen and screenshot.
- [ ] **Step 7:** Commit: `git add ui/src/lib/design && git commit -m "feat(ui): restyle base components (minimal Carbon+Green)"`

---

## Task 3: Restyle auth screens (Login + DeviceCode)

**Files:** Modify `ui/src/screens/Login.svelte`, `ui/src/screens/DeviceCode.svelte`. (Behavior/store calls unchanged.)

- [ ] **Step 1:** `Login.svelte` (spec §5) — centered card (`Panel`) on `--bg`; a wordmark (`XBOX REMOTE`, mono, letter-spaced); a single `primary` Button "Sign in to Xbox"; `authStore.error` shown in `--bad`. A small live dot only when signed-in/active (accent).
- [ ] **Step 2:** `DeviceCode.svelte` (spec §5) — centered card; the `user_code` large in mono (`--text-xl`, `--text`) with a "copy" ghost button; the `verification_uri` as an accent link/button; a quiet "waiting for sign-in…" line with an accent live dot. (Keep the existing polling `$effect` + cleanup.)
- [ ] **Step 2.5 — semantic check:** the only accent here is the live dot + the primary action; errors are `--bad`. No accent on neutral chrome.
- [ ] **Step 3:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run build`. Visual: `npm run dev`, screenshot Login (and DeviceCode if you can force its state) — compare to spec §5.
- [ ] **Step 4:** Commit: `git add ui/src/screens/Login.svelte ui/src/screens/DeviceCode.svelte && git commit -m "feat(ui): restyle auth + device-code screens"`

---

## Task 4: Restyle console picker (ConsoleList)

**Files:** Modify `ui/src/screens/ConsoleList.svelte`.

- [ ] **Step 1:** (spec §5) Header row: signed-in live dot (accent) + `signed in · <user>` (dim) + `XBOX REMOTE` wordmark (right). Section label `YOUR CONSOLES` (dim, mono, `--text-xs`, letter-spaced).
- [ ] **Step 2:** Console cards (one per `authStore.consoles`): `1px solid --border`, `--radius-md`, `--space-3` padding; left = `deviceName` (`--text`) over `consoleType` (dim, mono, `--text-xs`); right = a power-state `Badge` (`powerState` ON → tone `good`; else tone `neutral` "STANDBY") + a Connect affordance (accent, calls the existing `onConnect(console)`); STANDBY rows slightly dimmed.
- [ ] **Step 3:** Loading / empty / error states styled (dim text; error in `--bad`).
- [ ] **Step 4:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run build`. Visual: temporarily render with 2 mock consoles (one ON, one STANDBY), screenshot, compare to spec §5; remove the mock before committing.
- [ ] **Step 5:** Commit: `git add ui/src/screens/ConsoleList.svelte && git commit -m "feat(ui): restyle console picker"`

---

## Task 5: Stream view — Player layout (default)

**Files:** Modify `ui/src/screens/Stream.svelte`, `ui/src/components/StreamControls.svelte`, `ui/src/components/StreamStatus.svelte`. (Video binding, dual-track playback, control wiring UNCHANGED.)

- [ ] **Step 1:** `Stream.svelte` Player layout (spec §2.4 / §5): a flex column — top status strip, a bordered video stage (`flex:1`, `--border`, `--radius-md`, `<video>` fills), bottom control bar. Keep the existing `<video>` srcObject `$effect` + 250ms-play + Unmute fallback exactly.
- [ ] **Step 2:** `StreamStatus.svelte` — the top strip: live dot (tone by `connectionStore.state`: streaming=`--accent`, connecting/reconnecting=`--warn`, failed=`--bad`), console name (`--text`), then at-a-glance stats from `connectionStore.snapshot` (fps / loss / rtt) — dim labels, `--text` values, accent on the healthy one, `--warn`/`--bad` when a value crosses a threshold (e.g. loss > 2% → warn, > 5% → bad). A dim `` ` `` HUD hint at the right.
- [ ] **Step 3:** `StreamControls.svelte` bottom bar — `--surface`, top hairline; volume (speaker icon accent, slider fill `--accent`, persisted as today), then `focus`, `fullscreen`, `keyframe` (ghost), and `disconnect` (`--bad` outline). Keep all existing handlers.
- [ ] **Step 4:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run test` (pass) + `npm --prefix ui run build`. Visual: render Stream with a mock MediaStream + mock snapshot, screenshot the Player layout (healthy AND a forced-degraded state to prove warn/bad tones).
- [ ] **Step 5:** Commit: `git add ui/src/screens/Stream.svelte ui/src/components/StreamControls.svelte ui/src/components/StreamStatus.svelte && git commit -m "feat(ui): stream Player layout + status strip + control bar"`

---

## Task 6: Stream view — Stage focus mode

**Files:** Modify `ui/src/screens/Stream.svelte`, `ui/src/components/StreamControls.svelte`.

- [ ] **Step 1:** Re-skin the existing focus mode as "Stage" (spec §2.4): video fills full-bleed (stage covers the strip + bar); a floating status pill (top-left: live dot + console name, on a translucent `--surface`/`--border` rounded pill); a dim `` ` `` HUD hint (top-right); a floating control bar (bottom, translucent `--surface`, `--radius-md`) that **auto-hides** after ~2.5s idle and reappears on mousemove (this auto-hide already exists in `StreamControls` focus mode — keep it). Escape exits to Player (existing).
- [ ] **Step 2:** Ensure the toggle between Player and Stage is one action (the existing focus toggle) and that the HUD still toggles via `` ` `` in both modes.
- [ ] **Step 3:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run build`. Visual: screenshot Stage mode (controls visible AND hidden) — confirm chrome-free, Discord-clean.
- [ ] **Step 4:** Commit: `git add ui/src/screens/Stream.svelte ui/src/components/StreamControls.svelte && git commit -m "feat(ui): Stage focus mode (chrome-free, auto-hide controls)"`

---

## Task 7: Diagnostics HUD restyle + final polish & verification

**Files:** Modify `ui/src/components/DiagnosticsHud.svelte` + `ui/src/components/hud/{VideoPanel,NetworkPanel,PacketPanel,SessionPanel,ChannelPanel}.svelte`.

- [ ] **Step 1:** `DiagnosticsHud.svelte` — `--surface` panel, `--border`, `--radius-lg`, `--shadow-md`; header `DIAGNOSTICS` (mono, dim, letter-spaced) + `` ` `` close hint; compact group layout. Keep the `` ` `` toggle + `snapshot` prop.
- [ ] **Step 2:** Each panel — group label (dim, mono, `--text-xs`, letter-spaced) over a row of `Stat`s. Apply the **semantic color rule** to every metric:
  - Video: freezeCount/dropped > 0 → `--warn`/`--bad`; else values `--text`, healthy freezes=0 in `--accent`.
  - Network: `localCandidateType`/`remoteCandidateType` `relay` and provenance `xbox-provided` → `--accent`; `fallback-only` → `--bad`; rtt high → `--warn`.
  - Packets: lossPct (>2% warn, >5% bad), pliCount > 0 → warn.
  - Session: state via `Badge` tone (streaming=good, reconnecting=warn, failed=bad).
  Pick sensible thresholds and define them as named consts at the top of each panel.
- [ ] **Step 3:** `npm --prefix ui run check` (0 errors) + `npm --prefix ui run test` (the 58 HUD tests still pass — they assert data mapping, not styles) + `npm --prefix ui run build`. Visual: render the HUD with `mockSnapshot` (healthy) AND a degraded mock (high loss, fallback-only, freezes) — screenshot both, confirm green-vs-trouble tones.
- [ ] **Step 4 — single-source-of-truth gate:** Run `git grep -nE "#[0-9a-fA-F]{3,8}" -- 'ui/src/**/*.svelte'` → expect NO matches (all colors come from tokens). Fix any stray hardcoded hex by replacing with a token. (Hex inside `tokens.css` is the only allowed place.)
- [ ] **Step 5:** Commit: `git add ui/src/components/DiagnosticsHud.svelte ui/src/components/hud && git commit -m "feat(ui): restyle diagnostics HUD with semantic color rule"`

---

## Final verification
- [ ] `npm --prefix ui run check` → 0 type errors.
- [ ] `npm --prefix ui run test` → all tests pass (147).
- [ ] `npm --prefix ui run build` + `cargo build` → succeed.
- [ ] `git grep -nE "#[0-9a-fA-F]{3,8}" -- 'ui/src/**/*.svelte'` → empty (single source of truth).
- [ ] Visual: every screen (Login, DeviceCode, ConsoleList, Stream-Player, Stream-Stage, HUD) matches spec §5 in the Carbon+Green minimal look; a forced degraded state shows warn/bad tones, healthy shows only accent/dim.
- [ ] No behavior regression — same stores/commands; diff is visual-only.

Maps to spec §7 acceptance criteria.
