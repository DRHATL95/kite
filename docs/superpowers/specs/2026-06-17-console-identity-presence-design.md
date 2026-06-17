# Console Identity & Presence — Design

- **Date:** 2026-06-17
- **Status:** Approved (pending spec review)
- **Area:** Frontend (Svelte UI) only — no backend changes

## Overview

Today the app shows consoles as text-only cards, and the moment between
clicking "Connect" and the first video frame is a bare status pill on a black
screen. This feature gives each console a visual identity — a themed, stylized
illustration keyed to its model — and uses it across three moments:

1. **Console list** (pre-connect) — each card shows its model artwork + info.
2. **Connecting splash** (during the handshake) — the target console "powers
   on" with animation while the WebRTC session negotiates, filling the dead-air
   before the first video frame.
3. **Diagnostics HUD** (during streaming) — the HUD gains the console's
   name + model (text only, no artwork).

### Goals

- Make consoles instantly recognizable at a glance, especially with multiple
  consoles on one account.
- Turn the connecting dead-air into intentional, branded feedback.
- Surface "what am I connected to" during a session without new always-on chrome.

### Non-goals (YAGNI)

- No fetching of real console photos (the xHome API returns none — see below).
- No new always-on overlay chip on the live stream. Identity lives in the
  existing toggleable HUD.
- No backend / Rust changes. Every field already exists on the wire.

## Key constraint: the API gives no image

`XHomeConsole` ([src/xhome.rs:9](../../../src/xhome.rs)) returns only:
`serverId`, `deviceName`, `consoleType`, `powerState`, `isDevKit`, `playPath`.
There is no photo or image URL. So "an image of the console" is a **local,
bundled asset selected by `consoleType`** — a closed enum of five values the UI
already maps to labels in
[ConsoleList.svelte:79](../../../ui/src/screens/ConsoleList.svelte).

The artwork is **flat stylized SVG** (chosen over realistic renders / a generic
glyph): tiny, vector-crisp at any size, recolorable from the active theme's
`--accent`, offline-safe, and free of product-imagery licensing concerns.

## Components & surfaces

### `ConsoleArt.svelte` (new) — the single source of truth

A presentational component that maps a `consoleType` string to the matching
flat SVG illustration.

- **Props:** `consoleType: string`, `size?: number` (px, default sensible for a
  list card), and an optional `dimmed?: boolean` for standby rows.
- **Models:** `XboxSeriesX`, `XboxSeriesS`, `XboxOne`, `XboxOneS`, `XboxOneX`.
  Each has a recognizable silhouette and correct base color — black monolith /
  slab for Series X, One, One X; white box / slab for Series S, One S — so the
  art matches the real hardware's color and form factor.
- **Fallback:** any unknown / future `consoleType` renders a neutral generic
  console glyph (never breaks).
- **Theming:** accent details (the power ring/vent) use `var(--accent)` so the
  console lights up green in Carbon, cyan in Midnight, magenta in Synthwave,
  amber in Ember. Body fills are model-correct, not themed.
- **Map mirrors the label map:** a `consoleType → renderer` lookup sits beside
  the existing `consoleTypeLabel()` so the two stay in sync.

### Surface 1 — Console list cards

Edit [ConsoleList.svelte](../../../ui/src/screens/ConsoleList.svelte):

- Add `<ConsoleArt>` on the left of each card.
- Keep `deviceName` + `consoleTypeLabel(consoleType)` + the existing power
  `Badge`; add a derived one-line status: "ready to stream" when on,
  "asleep" otherwise (derived from `powerState` via the existing `isOn()`).
- Standby cards already dim via `.console-card--standby`; pass `dimmed` to the
  art so it dims with the row.
- `isDevKit` badge behavior is unchanged.

### Surface 2 — `ConnectingSplash.svelte` (new)

Shown on the Stream screen from the start of connection until the first video
frame, replacing today's bare status pill on black.

- **Content:** a large `<ConsoleArt>` for the target console, the console name
  ("Waking {deviceName}"), the model + a status subline, an indeterminate
  progress bar, and three step indicators: **session → handshake → video**.
- **Real progress, not faked:** the step indicators map to the
  `DiagnosticsSnapshot.state` / connection lifecycle the
  [ConnectionManager](../../../ui/src/lib/connection/ConnectionManager.ts)
  already emits (`connecting` → `streaming`). The splash advances as the actual
  session does.
- **Dismissal:** hidden once the live video is actually playing — keyed off the
  video element starting playback in [Stream.svelte](../../../ui/src/screens/Stream.svelte)
  (the existing 250ms delayed-play effect already knows when `play()` resolves),
  with the `streaming` state as a fallback signal.
- **Animation** (CSS keyframes only — no JS timers, so it stays smooth while the
  main thread negotiates SDP/ICE):
  - the console gently floats (`translateY`),
  - the accent power ring pulses opacity (a "powering on" breath),
  - a soft accent glow pulses behind it (flat circle, opacity+scale — no blur/gradient),
  - an indeterminate bar sweep,
  - the active step's dot pulses; completed steps are solid, pending steps dim.
  - All animation is wrapped so `prefers-reduced-motion: reduce` freezes it —
    the app already declares this globally in
    [tokens.css:183](../../../ui/src/lib/design/tokens.css).

### Surface 3 — Console identity in the HUD (text only)

The diagnostics HUD ([DiagnosticsHud.svelte](../../../ui/src/components/DiagnosticsHud.svelte))
is already behind a toggle and defaults to `visible = false` — that *is* the
"disabled by default" behavior requested. No new floating chip.

- Add the console **name + model** to the HUD — a compact identity line in the
  HUD header (next to the `DIAGNOSTICS` title) or at the top of
  [SessionPanel.svelte](../../../ui/src/components/hud/SessionPanel.svelte).
  No artwork in the HUD.

## Data plumbing

No backend changes. The only new data is console identity reaching the HUD
snapshot:

- Add two optional fields to `DiagnosticsSnapshot`
  ([types.ts](../../../ui/src/lib/connection/types.ts)): `consoleName: string | null`
  and `consoleType: string | null`.
- Add both to the `ManagerStats` `Pick` (they are manager-owned).
- `ConnectionManager` already stores `_consoleName`; also capture
  `_consoleType` from the `XHomeConsole` at connect, and include both in the
  manager-stats merge.
- The console list (Surface 1) and splash (Surface 2) read the console object
  directly — they do not need the snapshot.

## Testing

- **Unit (Vitest):** `ConsoleArt` renders the correct SVG for each of the five
  `consoleType` values and the fallback for an unknown type; `dimmed` applies.
- **Splash:** step state derives correctly from connection state; reduced-motion
  disables animation classes.
- Update existing ConsoleList / HUD tests for the new markup and snapshot fields.

## Files touched

**New**
- `ui/src/lib/components/ConsoleArt.svelte` (or alongside existing design components)
- `ui/src/components/ConnectingSplash.svelte`

**Edited**
- `ui/src/screens/ConsoleList.svelte` — artwork + status line
- `ui/src/screens/Stream.svelte` — render splash until first frame
- `ui/src/components/DiagnosticsHud.svelte` and/or `hud/SessionPanel.svelte` — identity line
- `ui/src/lib/connection/types.ts` — `consoleName` / `consoleType` snapshot fields
- `ui/src/lib/connection/ConnectionManager.ts` — capture + merge console identity

## Rebuild note

Per CLAUDE.md, after UI changes run `npm --prefix ui run build`, then
`cargo clean -p xbox-remote && cargo run` so Tauri re-embeds `ui/dist`.
