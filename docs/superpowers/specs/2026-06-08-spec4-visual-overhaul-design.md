# Spec 4 — Visual Overhaul — Design Spec

- **Date:** 2026-06-08
- **Status:** Draft (awaiting user review)
- **Spec:** 4 of 4 in the "Greatly Improve Xbox Remote" program
- **Depends on:** Spec 2 (the Svelte 5 frontend + design-system foundation it restyles)

---

## 1. Program context

| # | Spec | Status |
|---|------|--------|
| 1 | Foundation cleanup | ✅ Merged |
| 2 | Frontend re-platform + HUD | ✅ Merged, validated on real hardware |
| 3 | Stream stability (audio-first) | 📋 Spec written; **deferred** — streaming already validated smooth, so its fixes are optional insurance, not needed now |
| **4** | **Visual overhaul** (this doc) | Draft |

The app now works well — continuous, smooth streaming confirmed on the owner's Xbox. Spec 4
is the **visual finish**: it turns the deliberately clean-but-minimal Spec 2 UI into a
polished, cohesive aesthetic. **This is a re-skin, not new functionality.** No streaming
logic, no `ConnectionManager`, no protocol code changes — only `ui/src/lib/design/*` and the
visual layer of the screens/components.

---

## 2. Locked decisions (from the visual-companion brainstorm)

1. **Style: Minimal / "pro-tool."** Restrained, dark, info-friendly; monospace for data and
   technical labels, a clean sans for general UI. Stats read like a clean dashboard.
2. **Palette: "Carbon + Green"** — one accent, used consistently. Exact tokens:
   | Token | Hex | Use |
   |---|---|---|
   | `--bg` | `#0d0f0d` | app background |
   | `--surface` | `#161916` | panels, bars, cards |
   | `--surface-2` | `#1d211d` | raised/hover surface |
   | `--border` | `#242824` | hairlines, card/panel borders |
   | `--text-dim` | `#7e857e` | labels, secondary text |
   | `--text` | `#e8ece8` | primary text, values |
   | `--accent` | `#43c463` | **good/active** only |
   | `--warn` | `#e0b341` | trouble (amber) |
   | `--bad` | `#d4685f` | trouble (red) |
3. **Semantic color rule (important):** the green accent means **good / active / healthy**
   (live dot, ON badge, healthy stat values, `relay`/`xbox-provided`, volume fill). Amber
   (`--warn`) and red (`--bad`) are **reserved strictly for trouble** (loss spikes, freezes,
   `fallback-only`, disconnect/failed). This makes every screen instantly scannable:
   all-green = fine, any color = look here.
4. **Stream view: "Player" default + one-key "Stage" focus mode.**
   - **Player (default):** slim top strip (live dot · console name · at-a-glance stats:
     fps / loss / rtt · HUD hint) + persistent bottom control bar (volume · focus · fullscreen ·
     keyframe · disconnect) framing a bordered video stage.
   - **Stage (focus mode):** video fills the frame; a floating status pill + a floating
     control bar that auto-hide when idle. Chrome-free — the clean view to screen-share to
     Discord. (This is the existing Spec 2 "focus mode," re-skinned and elevated.)
5. **Console picker:** post-sign-in landing — console cards (name · type · power-state badge
   [green `● ON` / dim `STANDBY`] · Connect).
6. **Diagnostics HUD:** backtick (`` ` ``) toggle; grouped **Video / Network / Packets /
   Session** panels with the semantic color rule. Network panel keeps the Spec-3-relevant
   provenance (`xbox-provided` vs `fallback-only`) and candidate type (`relay`) prominent.
7. **Auth + device-code screens** inherit the same frame (centered card, mono code display).

---

## 3. Typography

- **Sans (general UI):** `system-ui, "Segoe UI", sans-serif` — headings, body, buttons, names.
- **Mono (data/technical):** `ui-monospace, "Cascadia Code", Menlo, monospace` — all metrics,
  stat labels/values, console technical fields, the HUD, the device code.
- A small type scale (already roughed in Spec 2 `tokens.css`): `--text-xs … --text-xl`. Spec 4
  finalizes sizes for the minimal density (tight, legible at a glance).

---

## 4. Architecture (what changes)

Spec 4 edits the **visual layer only** of the existing Spec 2 frontend. No new files of
substance; no logic touched.

| File(s) | Change |
|---|---|
| `ui/src/lib/design/tokens.css` | Replace the foundation tokens with the locked Carbon+Green palette, the two font stacks, finalized type/space/radius scale, and `--warn`/`--bad`. Single source of truth. |
| `ui/src/lib/design/{Button,Panel,Stat,Toggle,Badge}.svelte` | Restyle to the minimal aesthetic + tokens. `Badge` gains tone→token mapping (good=accent, warn, bad, neutral=dim). `Stat` uses mono for value, dim label, optional tone. |
| `ui/src/screens/ConsoleList.svelte` | Console-card treatment (name/type/power badge/Connect) per §2.5. |
| `ui/src/screens/Login.svelte`, `DeviceCode.svelte` | Centered-card frame; mono device code, green verification affordance. |
| `ui/src/screens/Stream.svelte` | Player layout (top strip + framed stage + bottom bar); Stage focus mode (chrome-free, floating auto-hide controls) re-skinned. |
| `ui/src/components/StreamControls.svelte` | Restyle the control bar (volume fill = accent; disconnect = `--bad`); ensure it both docks (Player) and floats/auto-hides (Stage). |
| `ui/src/components/StreamStatus.svelte` | Status pill / strip with semantic tones (streaming=accent, reconnecting=warn, failed=bad). |
| `ui/src/components/DiagnosticsHud.svelte` + `hud/*.svelte` | Panel/Stat restyle; apply the semantic color rule to every metric (healthy=accent, threshold-crossing=warn/bad). |

**Boundary:** components keep their existing props/behavior and store wiring. Spec 4 only
changes markup/styles. If a component needs a new prop for a visual state (e.g. `Stat` tone
thresholds), it's additive and local.

---

## 5. Per-screen treatment (summary)

- **Login:** centered card on `--bg`; wordmark; one primary (accent) "Sign in to Xbox" button; error in `--bad`.
- **DeviceCode:** centered card; the user code large in mono with a copy affordance; verification URL as an accent link/button; a quiet "waiting…" line with the live dot.
- **ConsoleList:** header (signed-in dot + `XBOX REMOTE` wordmark); `YOUR CONSOLES` label; console cards as in §2.5; ON = accent badge, STANDBY = dim; Connect in accent.
- **Stream (Player):** top strip + bottom control bar around a bordered stage; stats inline and dim with accent on the key/healthy value; volume fill = accent.
- **Stream (Stage / focus):** full-bleed stage; floating status pill (top-left) + `` ` `` HUD hint (top-right) + floating control bar (bottom) that fade after idle; Escape returns to Player.
- **HUD:** `DIAGNOSTICS` title + `` ` `` close; Video / Network / Packets / Session groups; semantic tones throughout.

---

## 6. Out of scope
- Any streaming/protocol/behavior change (that's Spec 1–3 territory; all done/deferred).
- New features (no settings panel, no themes/light-mode — single dark Carbon+Green identity).
- The tracked follow-ups (keyboard-input wiring; HUD `outboundPacketHz`/`lastSequence`) — separate.
- Spec 3 stability work — deferred.

---

## 7. Acceptance criteria
1. `ui/src/lib/design/tokens.css` defines exactly the §2 palette + the two font stacks + the
   finalized scales; every component/screen references tokens (no stray hardcoded colors —
   `git grep` for hex codes in `ui/src/**/*.svelte` returns only tokens.css).
2. All screens (Login, DeviceCode, ConsoleList, Stream-Player, Stream-Stage) and the HUD
   render in the locked minimal Carbon+Green look.
3. The **semantic color rule** holds: accent only for good/active; warn/bad only for trouble.
   Demonstrated by a deliberate "degraded" state (e.g. high loss / fallback-only / reconnecting)
   showing warn/bad tones.
4. Player is the default stream view; the `` ` `` HUD toggle and the Stage focus mode work.
5. `npm --prefix ui run check` → 0 type errors; `npm --prefix ui run test` → still pass;
   `npm --prefix ui run build` + `cargo build` succeed.
6. No regression in behavior — the screens still drive the same stores/commands (visual-only diff).

---

## 8. Verification reality (Spec 4 is fully verifiable here)
Unlike streaming, the visual layer renders **without an Xbox**: `npm --prefix ui run dev`
serves the UI in a browser (invoke calls fail, but layout/styling render), so each screen can
be screenshotted and reviewed during implementation — including a forced "degraded" state to
prove the semantic color rule. The full app is then confirmed with `npm --prefix ui run build`
+ `cargo run` against the owner's Xbox for the live look.
