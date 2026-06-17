# Console Identity & Presence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Give each Xbox console a themed, model-specific illustration and use it across three surfaces — the console list, an animated "connecting" splash, and a text identity line in the diagnostics HUD.

**Architecture:** All UI/Svelte; no Rust/backend changes. Decision logic (which model, splash step states, splash visibility) lives in pure TypeScript modules under `ui/src/lib/console/` and is unit-tested with Vitest. The `.svelte` components stay thin and are validated by `svelte-check` (`npm run check`) — matching this repo's existing testing philosophy (see [DiagnosticsHud.test.ts](../../../ui/src/components/hud/DiagnosticsHud.test.ts), which tests data/logic, not rendered DOM). Console identity reaches the HUD by adding two fields to the existing `DiagnosticsSnapshot` pipeline.

**Tech Stack:** Svelte 5 (runes), TypeScript, Vite, Vitest (jsdom), CSS custom-property design tokens.

**Test commands (this repo):**
- Single test file: `npm --prefix ui run test -- <name-fragment>` (e.g. `consoleArt`)
- All UI tests: `npm --prefix ui run test`
- Type/Svelte check: `npm --prefix ui run check`
- Production build (Tauri embeds `ui/dist`): `npm --prefix ui run build`

All commands run from the repo root. Every commit message ends with the `Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>` trailer.

---

## File Structure

**New files**
- `ui/src/lib/console/consoleArt.ts` — pure: `consoleType → ConsoleModelKey` resolver + `consoleTypeLabel`.
- `ui/src/lib/console/consoleArt.test.ts` — unit tests for the above.
- `ui/src/lib/console/connectingSplash.ts` — pure: splash step-state + visibility logic.
- `ui/src/lib/console/connectingSplash.test.ts` — unit tests for the above.
- `ui/src/components/ConsoleArt.svelte` — renders the flat SVG illustration for a model.
- `ui/src/components/ConnectingSplash.svelte` — the animated connecting overlay.

**Modified files**
- `ui/src/lib/design/tokens.css` — add console-illustration color tokens.
- `ui/src/screens/ConsoleList.svelte` — artwork + status line; import label from the new module.
- `ui/src/lib/connection/types.ts` — `consoleName` / `consoleType` on `DiagnosticsSnapshot` + `ManagerStats`.
- `ui/src/lib/connection/stats.ts` — default the two new manager fields.
- `ui/src/components/hud/mockSnapshot.ts` — populate the two new fields.
- `ui/src/components/hud/DiagnosticsHud.test.ts` — assert the two new fields.
- `ui/src/lib/connection/ConnectionManager.ts` — capture `_consoleType`; merge identity into manager stats.
- `ui/src/components/hud/SessionPanel.svelte` — identity line (name + model, no art).
- `ui/src/lib/stores/connection.svelte.ts` — retain `currentConsole` for the splash.
- `ui/src/screens/Stream.svelte` — render the splash until the first video frame.

---

## Task 1: Console art resolver + label (pure logic)

**Files:**
- Create: `ui/src/lib/console/consoleArt.ts`
- Test: `ui/src/lib/console/consoleArt.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/console/consoleArt.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { resolveConsoleModel, consoleTypeLabel } from "./consoleArt.js";

describe("resolveConsoleModel", () => {
  it("maps each known console type to its model key", () => {
    expect(resolveConsoleModel("XboxSeriesX")).toBe("seriesX");
    expect(resolveConsoleModel("XboxSeriesS")).toBe("seriesS");
    expect(resolveConsoleModel("XboxOne")).toBe("one");
    expect(resolveConsoleModel("XboxOneS")).toBe("oneS");
    expect(resolveConsoleModel("XboxOneX")).toBe("oneX");
  });

  it("falls back to 'generic' for unknown or empty types", () => {
    expect(resolveConsoleModel("XboxSeriesZ")).toBe("generic");
    expect(resolveConsoleModel("")).toBe("generic");
  });
});

describe("consoleTypeLabel", () => {
  it("returns friendly labels for known types", () => {
    expect(consoleTypeLabel("XboxSeriesX")).toBe("Xbox Series X");
    expect(consoleTypeLabel("XboxOneS")).toBe("Xbox One S");
  });

  it("returns the raw type for unknown values", () => {
    expect(consoleTypeLabel("XboxSeriesZ")).toBe("XboxSeriesZ");
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix ui run test -- consoleArt`
Expected: FAIL — cannot resolve `./consoleArt.js` (module does not exist yet).

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/console/consoleArt.ts`:

```ts
/**
 * consoleArt.ts — Pure presentation logic for console identity.
 *
 * The xHome API returns no console image, only a `consoleType` enum string.
 * We map that string to a model key (which artwork to draw) and to a friendly
 * label. Both are pure functions so they can be unit-tested without mounting
 * the Svelte component (the .svelte file is validated by svelte-check).
 */

/** Which bundled illustration to render. */
export type ConsoleModelKey =
  | "seriesX"
  | "seriesS"
  | "one"
  | "oneS"
  | "oneX"
  | "generic";

const MODEL_BY_TYPE: Record<string, ConsoleModelKey> = {
  XboxSeriesX: "seriesX",
  XboxSeriesS: "seriesS",
  XboxOne: "one",
  XboxOneS: "oneS",
  XboxOneX: "oneX",
};

/** Resolve a console type string to its artwork model key (fallback: generic). */
export function resolveConsoleModel(consoleType: string): ConsoleModelKey {
  return MODEL_BY_TYPE[consoleType] ?? "generic";
}

const LABEL_BY_TYPE: Record<string, string> = {
  XboxSeriesX: "Xbox Series X",
  XboxSeriesS: "Xbox Series S",
  XboxOne: "Xbox One",
  XboxOneS: "Xbox One S",
  XboxOneX: "Xbox One X",
};

/** Friendly display label for a console type (fallback: the raw string). */
export function consoleTypeLabel(consoleType: string): string {
  return LABEL_BY_TYPE[consoleType] ?? consoleType;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix ui run test -- consoleArt`
Expected: PASS (all cases green).

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/console/consoleArt.ts ui/src/lib/console/consoleArt.test.ts
git commit -m "$(cat <<'EOF'
feat(console): consoleType→model resolver + label (pure, tested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 2: ConsoleArt.svelte component + tokens

**Files:**
- Create: `ui/src/components/ConsoleArt.svelte`
- Modify: `ui/src/lib/design/tokens.css` (add illustration tokens to the base `:root` block)

- [ ] **Step 1: Add illustration tokens**

In `ui/src/lib/design/tokens.css`, inside the base `:root { … }` block, immediately after the `--radius-*` line (`--radius-sm: 5px; … --radius-pill: 999px;`), add:

```css
  /* ── Console illustration (theme-independent product colours) ─────────── */
  --console-dark: #14171a;        /* black-console body */
  --console-light: #e6e6df;       /* white-console body */
  --console-edge: #3a413a;        /* outline on dark bodies */
  --console-edge-light: #b9b9b0;  /* outline on light bodies */
```

These are deliberately in the theme-independent section: a Series X is black in every theme. The accent ring/power dot uses the themed `--accent`, so the console "lights up" in the active theme.

- [ ] **Step 2: Create the component**

Create `ui/src/components/ConsoleArt.svelte`:

```svelte
<script lang="ts">
  /**
   * ConsoleArt.svelte — Flat, themed SVG illustration of an Xbox console.
   *
   * Picks the silhouette from `consoleType` via resolveConsoleModel(). Body
   * colours are model-correct (black towers/slabs vs. white boxes); the power
   * ring / dot uses --accent so it tints with the active theme. The element
   * carrying class `console-art__pulse` is the accent highlight — the
   * connecting splash animates it via a :global selector.
   */
  import { resolveConsoleModel } from "$lib/console/consoleArt.js";

  interface Props {
    /** Xbox consoleType string (e.g. "XboxSeriesX"). */
    consoleType: string;
    /** Rendered size in px (square). */
    size?: number;
    /** Dim the art (used for standby consoles). */
    dimmed?: boolean;
  }

  let { consoleType, size = 48, dimmed = false }: Props = $props();

  const model = $derived(resolveConsoleModel(consoleType));
</script>

<span
  class="console-art"
  class:console-art--dimmed={dimmed}
  style="--art-size: {size}px"
  aria-hidden="true"
>
  {#if model === "seriesX"}
    <svg viewBox="0 0 64 64">
      <rect x="23" y="5" width="18" height="54" rx="4" fill="var(--console-dark)" stroke="var(--console-edge)" />
      <circle cx="32" cy="14" r="6" fill="var(--console-dark)" stroke="var(--accent)" stroke-width="1.6" />
      <circle class="console-art__pulse" cx="32" cy="14" r="2.3" fill="var(--accent)" />
    </svg>
  {:else if model === "seriesS"}
    <svg viewBox="0 0 64 64">
      <rect x="14" y="17" width="36" height="30" rx="4" fill="var(--console-light)" stroke="var(--console-edge-light)" />
      <circle cx="24" cy="32" r="7" fill="var(--console-dark)" />
      <circle class="console-art__pulse" cx="44" cy="42" r="2.2" fill="var(--accent)" />
    </svg>
  {:else if model === "one"}
    <svg viewBox="0 0 64 64">
      <rect x="7" y="22" width="50" height="20" rx="3" fill="var(--console-dark)" stroke="var(--console-edge)" />
      <line x1="32" y1="22" x2="32" y2="42" stroke="var(--console-edge)" />
      <circle class="console-art__pulse" cx="14" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {:else if model === "oneS"}
    <svg viewBox="0 0 64 64">
      <rect x="7" y="22" width="50" height="20" rx="3" fill="var(--console-light)" stroke="var(--console-edge-light)" />
      <circle class="console-art__pulse" cx="14" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {:else if model === "oneX"}
    <svg viewBox="0 0 64 64">
      <rect x="7" y="23" width="50" height="18" rx="3" fill="var(--console-dark)" stroke="var(--console-edge)" />
      <path d="M40 27 H52 M40 31 H52 M40 35 H52" stroke="var(--console-edge)" stroke-width="1" fill="none" />
      <circle class="console-art__pulse" cx="14" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {:else}
    <svg viewBox="0 0 64 64">
      <rect x="12" y="22" width="40" height="20" rx="4" fill="var(--surface-2)" stroke="var(--border)" />
      <circle class="console-art__pulse" cx="20" cy="32" r="2.2" fill="var(--accent)" />
    </svg>
  {/if}
</span>

<style>
  .console-art {
    display: inline-flex;
    width: var(--art-size);
    height: var(--art-size);
    flex-shrink: 0;
  }
  .console-art svg {
    width: 100%;
    height: 100%;
    display: block;
  }
  .console-art--dimmed {
    opacity: 0.55;
  }
</style>
```

- [ ] **Step 3: Verify the component type-checks**

Run: `npm --prefix ui run check`
Expected: PASS — no svelte-check / TypeScript errors.

- [ ] **Step 4: Commit**

```bash
git add ui/src/components/ConsoleArt.svelte ui/src/lib/design/tokens.css
git commit -m "$(cat <<'EOF'
feat(console): ConsoleArt.svelte themed per-model illustration

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 3: Console list cards — artwork + status line

**Files:**
- Modify: `ui/src/screens/ConsoleList.svelte`

- [ ] **Step 1: Import the component + shared label, drop the local label map**

In `ui/src/screens/ConsoleList.svelte`, add to the imports (after the existing `Badge` import):

```svelte
  import ConsoleArt from "../components/ConsoleArt.svelte";
  import { consoleTypeLabel } from "$lib/console/consoleArt.js";
```

Then delete the local `consoleTypeLabel` function (the block starting `/** Friendly console type label. */` through its closing `}` near line 79-88) so the imported one is used instead.

- [ ] **Step 2: Add a status-line helper**

In the same `<script>`, add next to the other helpers:

```svelte
  /** Short presence line derived from power state. */
  function statusLine(powerState: string): string {
    return isOn(powerState) ? "ready to stream" : "asleep";
  }
```

- [ ] **Step 3: Render the artwork + status line in each card**

Replace the card body (the `<li class="console-card" …> … </li>` block, lines ~160-184) with:

```svelte
            <li
              class="console-card"
              class:console-card--standby={!isOn(console.powerState)}
            >
              <ConsoleArt
                consoleType={console.consoleType}
                size={44}
                dimmed={!isOn(console.powerState)}
              />
              <div class="console-card__info">
                <div class="console-card__header">
                  <span class="console-card__name">{console.deviceName}</span>
                  {#if console.isDevKit}
                    <Badge tone="warn">Dev Kit</Badge>
                  {/if}
                </div>
                <div class="console-card__meta">
                  <span class="console-card__type">
                    {consoleTypeLabel(console.consoleType)}
                  </span>
                  <Badge tone={powerStateTone(console.powerState)}>
                    {powerStateLabel(console.powerState)}
                  </Badge>
                </div>
                <span class="console-card__status">{statusLine(console.powerState)}</span>
              </div>
              <Button
                disabled={!isOn(console.powerState)}
                onclick={() => onConnect(console)}
              >Connect →</Button>
            </li>
```

- [ ] **Step 4: Add the status-line style**

In the `<style>` block, after the `.console-card__type { … }` rule, add:

```css
  .console-card__status {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    margin-top: var(--space-1);
  }
```

- [ ] **Step 5: Verify check + build**

Run: `npm --prefix ui run check && npm --prefix ui run build`
Expected: PASS — no type errors; build writes `ui/dist`.

- [ ] **Step 6: Commit**

```bash
git add ui/src/screens/ConsoleList.svelte
git commit -m "$(cat <<'EOF'
feat(console): show artwork + presence on console list cards

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 4: Snapshot identity fields (types, defaults, mock, test)

**Files:**
- Modify: `ui/src/lib/connection/types.ts`
- Modify: `ui/src/lib/connection/stats.ts`
- Modify: `ui/src/components/hud/mockSnapshot.ts`
- Modify: `ui/src/components/hud/DiagnosticsHud.test.ts`

- [ ] **Step 1: Add the failing test assertions**

In `ui/src/components/hud/DiagnosticsHud.test.ts`, inside the `describe("mockSnapshot — completeness", …)` block, after the `// Input` group (the `lastSequence` assertion near line 110), add:

```ts
  // Identity
  it("consoleName is a string", () => expect(typeof mockSnapshot.consoleName).toBe("string"));
  it("consoleType is a string", () => expect(typeof mockSnapshot.consoleType).toBe("string"));
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix ui run test -- DiagnosticsHud`
Expected: FAIL — `mockSnapshot.consoleName` / `.consoleType` are `undefined` (not yet added), so `typeof` is `"undefined"`.

- [ ] **Step 3: Add the fields to `DiagnosticsSnapshot` and `ManagerStats`**

In `ui/src/lib/connection/types.ts`, inside `interface DiagnosticsSnapshot`, after the `// ── input ──` group (after the `lastSequence: number | null;` field, near line 240) add:

```ts

  // ── identity ───────────────────────────────────────────────
  /** Console display name (deviceName). Manager-supplied. */
  consoleName: string | null;
  /** Console model type string (consoleType). Manager-supplied. */
  consoleType: string | null;
```

Then in the `ManagerStats` `Pick<…>` union (ends with `| "lastSequence"`), add the two keys:

```ts
  | "lastSequence"
  | "consoleName"
  | "consoleType"
>;
```

- [ ] **Step 4: Default the new fields in the sampler**

In `ui/src/lib/connection/stats.ts`, inside `defaultManagerStats()`'s returned object, after `lastSequence: null,` add:

```ts
    consoleName: null,
    consoleType: null,
```

- [ ] **Step 5: Populate the mock snapshot**

In `ui/src/components/hud/mockSnapshot.ts`, after the `// Input` group (`lastSequence: 2641,`) and before the closing `};`, add:

```ts

  // Identity
  consoleName: "Living Room",
  consoleType: "XboxSeriesX",
```

- [ ] **Step 6: Run tests + check to verify they pass**

Run: `npm --prefix ui run test -- DiagnosticsHud && npm --prefix ui run check`
Expected: PASS — the two new assertions are green and the `mockSnapshot` still satisfies `DiagnosticsSnapshot` at compile time.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/connection/types.ts ui/src/lib/connection/stats.ts ui/src/components/hud/mockSnapshot.ts ui/src/components/hud/DiagnosticsHud.test.ts
git commit -m "$(cat <<'EOF'
feat(hud): add consoleName/consoleType to DiagnosticsSnapshot

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 5: ConnectionManager — capture + merge console identity

**Files:**
- Modify: `ui/src/lib/connection/ConnectionManager.ts`

- [ ] **Step 1: Add the `_consoleType` field**

In `ui/src/lib/connection/ConnectionManager.ts`, directly below the `_consoleName` field declaration (near line 131):

```ts
  private _consoleType: string | null = null;
```

- [ ] **Step 2: Capture it at connect**

In `connect()`, immediately after the `this._consoleName = … "Xbox";` assignment (near line 271-274), add:

```ts
    this._consoleType = xboxConsole.consoleType ?? null;
```

- [ ] **Step 3: Clear it on reset**

In the same file, where `this._consoleName = null;` is set during teardown (near line 301), add directly below it:

```ts
    this._consoleType = null;
```

- [ ] **Step 4: Merge identity into manager stats**

In `_pushManagerStats()`, inside the `const stats: ManagerStats = { … }` object (near line 1098), after `lastSequence: null,` add:

```ts
      consoleName: this._consoleName,
      consoleType: this._consoleType,
```

- [ ] **Step 5: Verify check**

Run: `npm --prefix ui run check`
Expected: PASS — `ManagerStats` is now fully satisfied (no missing-property error).

- [ ] **Step 6: Commit**

```bash
git add ui/src/lib/connection/ConnectionManager.ts
git commit -m "$(cat <<'EOF'
feat(connection): thread console identity into manager stats

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 6: HUD identity line (SessionPanel)

**Files:**
- Modify: `ui/src/components/hud/SessionPanel.svelte`

- [ ] **Step 1: Import the label helper**

In `ui/src/components/hud/SessionPanel.svelte`, add after the existing `Badge` import:

```svelte
  import { consoleTypeLabel } from "$lib/console/consoleArt.js";
```

- [ ] **Step 2: Render the identity line at the top of the panel**

Inside `<Panel title="Session">`, immediately before the `<!-- State + keepalive badges -->` block, add:

```svelte
  {#if snapshot?.consoleName}
    <div class="identity">
      <span class="identity__name">{snapshot.consoleName}</span>
      <span class="identity__type">{consoleTypeLabel(snapshot.consoleType ?? "")}</span>
    </div>
  {/if}
```

- [ ] **Step 3: Add the identity styles**

In the `<style>` block, after the `.badge-row { … }` rule, add:

```css
  .identity {
    display: flex;
    align-items: baseline;
    gap: var(--space-2);
    margin-bottom: var(--space-3);
  }

  .identity__name {
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    font-weight: 600;
    color: var(--text);
  }

  .identity__type {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }
```

- [ ] **Step 4: Verify check**

Run: `npm --prefix ui run check`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/components/hud/SessionPanel.svelte
git commit -m "$(cat <<'EOF'
feat(hud): show console name + model in the Session panel

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 7: Connecting splash logic (pure)

**Files:**
- Create: `ui/src/lib/console/connectingSplash.ts`
- Test: `ui/src/lib/console/connectingSplash.test.ts`

- [ ] **Step 1: Write the failing test**

Create `ui/src/lib/console/connectingSplash.test.ts`:

```ts
import { describe, it, expect } from "vitest";
import { connectingSteps, shouldShowSplash } from "./connectingSplash.js";

describe("connectingSteps", () => {
  it("starts with session done, handshake active, video pending", () => {
    expect(connectingSteps({ handshakeComplete: false, videoArrived: false })).toEqual({
      session: "done",
      handshake: "active",
      video: "pending",
    });
  });

  it("advances to video active once the handshake completes", () => {
    expect(connectingSteps({ handshakeComplete: true, videoArrived: false })).toEqual({
      session: "done",
      handshake: "done",
      video: "active",
    });
  });

  it("marks all steps done once video arrives", () => {
    expect(connectingSteps({ handshakeComplete: true, videoArrived: true })).toEqual({
      session: "done",
      handshake: "done",
      video: "done",
    });
  });
});

describe("shouldShowSplash", () => {
  it("hides as soon as the video is playing, regardless of state", () => {
    expect(shouldShowSplash("connecting", true)).toBe(false);
    expect(shouldShowSplash("streaming", true)).toBe(false);
  });

  it("shows while connecting / reconnecting / streaming with no frame yet", () => {
    expect(shouldShowSplash("connecting", false)).toBe(true);
    expect(shouldShowSplash("reconnecting", false)).toBe(true);
    expect(shouldShowSplash("streaming", false)).toBe(true);
  });

  it("never shows when idle or failed", () => {
    expect(shouldShowSplash("idle", false)).toBe(false);
    expect(shouldShowSplash("failed", false)).toBe(false);
  });
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm --prefix ui run test -- connectingSplash`
Expected: FAIL — cannot resolve `./connectingSplash.js`.

- [ ] **Step 3: Write the implementation**

Create `ui/src/lib/console/connectingSplash.ts`:

```ts
/**
 * connectingSplash.ts — Pure logic for the connecting splash overlay.
 *
 * `connectingSteps` derives the three step indicators (session → handshake →
 * video) from real, observable signals — never faked. The REST session already
 * exists by the time the splash shows (it produced the SDP offer), so `session`
 * is always done; `handshake` tracks data-channel handshake completion and
 * `video` tracks first-frame arrival.
 *
 * `shouldShowSplash` decides visibility: shown from connect start until the
 * <video> element is actually playing.
 */
import type { SessionState } from "../connection/types.js";

export type StepStatus = "done" | "active" | "pending";

export interface ConnectingSteps {
  session: StepStatus;
  handshake: StepStatus;
  video: StepStatus;
}

export interface ConnectingProgress {
  /** True once the data-channel handshake has completed (handshakeMs set). */
  handshakeComplete: boolean;
  /** True once the first video track has arrived (videoArrivedAt set). */
  videoArrived: boolean;
}

export function connectingSteps({
  handshakeComplete,
  videoArrived,
}: ConnectingProgress): ConnectingSteps {
  return {
    session: "done",
    handshake: handshakeComplete ? "done" : "active",
    video: videoArrived ? "done" : handshakeComplete ? "active" : "pending",
  };
}

export function shouldShowSplash(state: SessionState, videoPlaying: boolean): boolean {
  if (videoPlaying) return false;
  return state === "connecting" || state === "reconnecting" || state === "streaming";
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `npm --prefix ui run test -- connectingSplash`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add ui/src/lib/console/connectingSplash.ts ui/src/lib/console/connectingSplash.test.ts
git commit -m "$(cat <<'EOF'
feat(console): connecting-splash step + visibility logic (pure, tested)

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 8: ConnectingSplash.svelte component

**Files:**
- Create: `ui/src/components/ConnectingSplash.svelte`

- [ ] **Step 1: Create the component**

Create `ui/src/components/ConnectingSplash.svelte`:

```svelte
<script lang="ts">
  /**
   * ConnectingSplash.svelte — Animated overlay shown during the WebRTC
   * handshake, before the first video frame. Shows the target console
   * "powering on" with the step indicators driven by real progress.
   *
   * Pure CSS keyframes (opacity/transform) so it stays smooth while the main
   * thread negotiates SDP/ICE. Freezes under prefers-reduced-motion.
   */
  import ConsoleArt from "./ConsoleArt.svelte";
  import { consoleTypeLabel } from "$lib/console/consoleArt.js";
  import type { ConnectingSteps } from "$lib/console/connectingSplash.js";
  import type { XHomeConsole } from "$lib/ipc/types.js";

  interface Props {
    console: XHomeConsole | null;
    steps: ConnectingSteps;
  }

  let { console: xc, steps }: Props = $props();

  const name = $derived(xc?.deviceName || "Xbox");
  const type = $derived(xc?.consoleType ?? "");
</script>

<div class="splash" role="status" aria-live="polite">
  <div class="splash__glow" aria-hidden="true"></div>
  <div class="splash__art"><ConsoleArt consoleType={type} size={96} /></div>
  <div class="splash__title">Waking {name}</div>
  <div class="splash__sub">{consoleTypeLabel(type)} · negotiating connection</div>
  <div class="splash__bar" aria-hidden="true"><div class="splash__bar-fill"></div></div>
  <div class="splash__steps">
    <span class="step step--{steps.session}"><i class="dot"></i>session</span>
    <span class="step step--{steps.handshake}"><i class="dot"></i>handshake</span>
    <span class="step step--{steps.video}"><i class="dot"></i>video</span>
  </div>
</div>

<style>
  .splash {
    position: absolute;
    inset: 0;
    z-index: 5;
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: var(--space-3);
    background: var(--video-bg);
    text-align: center;
    padding: var(--space-5);
  }

  .splash__glow {
    position: absolute;
    width: 200px;
    height: 200px;
    border-radius: 50%;
    background: var(--accent);
    opacity: 0.18;
    animation: splashGlow 2.6s ease-in-out infinite;
  }

  .splash__art {
    position: relative;
    animation: splashFloat 3.4s ease-in-out infinite;
  }

  .splash :global(.console-art__pulse) {
    animation: splashRing 1.6s ease-in-out infinite;
  }

  .splash__title {
    font-family: var(--font-display);
    font-size: var(--text-lg);
    font-weight: 500;
    color: var(--text);
  }

  .splash__sub {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .splash__bar {
    position: relative;
    width: 220px;
    height: 4px;
    background: var(--surface-2);
    border-radius: var(--radius-pill);
    overflow: hidden;
  }

  .splash__bar-fill {
    position: absolute;
    top: 0;
    left: -40%;
    width: 40%;
    height: 100%;
    background: var(--accent);
    border-radius: var(--radius-pill);
    animation: splashSweep 1.5s ease-in-out infinite;
  }

  .splash__steps {
    display: flex;
    gap: var(--space-4);
    margin-top: var(--space-1);
  }

  .step {
    display: inline-flex;
    align-items: center;
    gap: var(--space-1);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
  }

  .step .dot {
    width: 6px;
    height: 6px;
    border-radius: 50%;
    background: var(--border);
  }

  .step--done {
    color: var(--accent);
  }
  .step--done .dot {
    background: var(--accent);
  }

  .step--active {
    color: var(--text);
  }
  .step--active .dot {
    background: var(--accent);
    animation: splashDot 1.2s ease-in-out infinite;
  }

  .step--pending {
    opacity: 0.6;
  }

  @keyframes splashFloat {
    0%, 100% { transform: translateY(0); }
    50%      { transform: translateY(-6px); }
  }
  @keyframes splashRing {
    0%, 100% { opacity: 0.5; }
    50%      { opacity: 1; }
  }
  @keyframes splashGlow {
    0%, 100% { opacity: 0.14; transform: scale(0.85); }
    50%      { opacity: 0.4;  transform: scale(1.12); }
  }
  @keyframes splashSweep {
    0%   { left: -40%; }
    100% { left: 100%; }
  }
  @keyframes splashDot {
    0%, 100% { opacity: 0.3; }
    50%      { opacity: 1; }
  }

  @media (prefers-reduced-motion: reduce) {
    .splash__art,
    .splash__glow,
    .splash__bar-fill,
    .step--active .dot,
    .splash :global(.console-art__pulse) {
      animation: none;
    }
  }
</style>
```

- [ ] **Step 2: Verify check**

Run: `npm --prefix ui run check`
Expected: PASS.

- [ ] **Step 3: Commit**

```bash
git add ui/src/components/ConnectingSplash.svelte
git commit -m "$(cat <<'EOF'
feat(console): animated ConnectingSplash overlay

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 9: Store retains current console + Stream renders the splash

**Files:**
- Modify: `ui/src/lib/stores/connection.svelte.ts`
- Modify: `ui/src/screens/Stream.svelte`

- [ ] **Step 1: Retain the in-flight console in the store**

In `ui/src/lib/stores/connection.svelte.ts`, add a reactive field after the `mediaStream` field (near line 54):

```ts
  /**
   * The console currently being connected to / streamed. Set on connect(),
   * cleared on disconnect(). Drives the connecting splash artwork + name.
   */
  currentConsole: XHomeConsole | null = $state(null);
```

In `connect()`, set it right after `this.failureReason = null;`:

```ts
    this.currentConsole = xboxConsole;
```

In `disconnect()`, after `this.mediaStream = null;` add:

```ts
    this.currentConsole = null;
```

(`XHomeConsole` is already imported in this file.)

- [ ] **Step 2: Track video-playing + import splash pieces in Stream**

In `ui/src/screens/Stream.svelte`, add to the imports (after the `DiagnosticsHud` import near line 27):

```svelte
  import ConnectingSplash from "../components/ConnectingSplash.svelte";
  import { connectingSteps, shouldShowSplash } from "$lib/console/connectingSplash.js";
```

Add a `videoPlaying` state next to the `needsUnmute` state (near line 49):

```svelte
  /** True once the <video> element is actually rendering frames. */
  let videoPlaying = $state(false);
```

In the `$effect` that binds `srcObject` (near line 61-103), reset the flag when the stream is (re)assigned. Add `videoPlaying = false;` immediately after the `videoEl.srcObject = stream ?? null;` line:

```svelte
    videoEl.srcObject = stream ?? null;
    videoPlaying = false;
```

- [ ] **Step 3: Derive splash visibility + steps**

In the same `<script>`, after the cleanup/`dotColor`/`stateLabel` helpers (near line 149), add:

```svelte
  // ── Connecting splash ──────────────────────────────────────────────────────────
  const showSplash = $derived(
    shouldShowSplash(connectionStore.state, videoPlaying),
  );
  const splashSteps = $derived(
    connectingSteps({
      handshakeComplete: connectionStore.snapshot?.handshakeMs != null,
      videoArrived: connectionStore.snapshot?.videoArrivedAt != null,
    }),
  );
```

- [ ] **Step 4: Mark the video as playing in both modes**

On the player-mode `<video class="stream-video" …>` element (near line 177) and the focus-mode `<video class="stage-video" …>` element (near line 212), add an `onplaying` handler. For each, add this attribute line inside the tag:

```svelte
        onplaying={() => (videoPlaying = true)}
```

- [ ] **Step 5: Render the splash inside both stages**

In player mode, inside `<div class="video-stage">` — immediately after the closing `</video>` of `stream-video` (before the `{#if needsUnmute}` block, near line 184) — add:

```svelte
      {#if showSplash}
        <ConnectingSplash console={connectionStore.currentConsole} steps={splashSteps} />
      {/if}
```

In focus mode, inside `<div class="stage-fullbleed">` — immediately after the closing `</video>` of `stage-video` (before its `{#if needsUnmute}` block, near line 219) — add the identical block:

```svelte
      {#if showSplash}
        <ConnectingSplash console={connectionStore.currentConsole} steps={splashSteps} />
      {/if}
```

(Both `.video-stage` and `.stage-fullbleed` are positioned containers, so the splash's `position: absolute; inset: 0` covers the stage while the controls bar — a sibling/higher layer — stays usable, so the user can still cancel.)

- [ ] **Step 6: Verify check + build**

Run: `npm --prefix ui run check && npm --prefix ui run build`
Expected: PASS — no type errors; build writes `ui/dist`.

- [ ] **Step 7: Commit**

```bash
git add ui/src/lib/stores/connection.svelte.ts ui/src/screens/Stream.svelte
git commit -m "$(cat <<'EOF'
feat(stream): show connecting splash until first video frame

Co-Authored-By: Claude Opus 4.8 <noreply@anthropic.com>
EOF
)"
```

---

## Task 10: Full verification

**Files:** none (verification only)

- [ ] **Step 1: Run the full UI test suite**

Run: `npm --prefix ui run test`
Expected: PASS — all suites green, including `consoleArt`, `connectingSplash`, and `DiagnosticsHud`.

- [ ] **Step 2: Type/Svelte check**

Run: `npm --prefix ui run check`
Expected: PASS — zero errors/warnings.

- [ ] **Step 3: Production build**

Run: `npm --prefix ui run build`
Expected: PASS — `ui/dist` regenerated.

- [ ] **Step 4: (Optional) run the app to view it live**

Per CLAUDE.md, the frontend does NOT auto-rebuild. To see it in the Tauri window:

```bash
npm --prefix ui run build
cargo clean -p xbox-remote
cargo run
```

Manually verify: console list shows per-model artwork + presence; connecting to a console shows the animated splash until video appears; opening the HUD (`` ` `` key) shows the console name + model in the Session panel.

---

## Self-Review (completed during planning)

- **Spec coverage:** Surface 1 → Tasks 1-3; Surface 2 → Tasks 7-9; Surface 3 (HUD) → Tasks 4-6; artwork system → Tasks 1-2; data plumbing → Tasks 4-5, 9; testing → Tasks 1, 4, 7, 10. All spec sections covered.
- **Placeholder scan:** No TBD/TODO; every code step shows complete code.
- **Type consistency:** `resolveConsoleModel`/`consoleTypeLabel` (Task 1) consumed in Tasks 2-3, 6, 8; `ConnectingSteps`/`connectingSteps`/`shouldShowSplash` (Task 7) consumed in Tasks 8-9; `consoleName`/`consoleType` defined in Task 4 and populated in Tasks 4-5; `currentConsole` defined in Task 9 used in Task 9. Names match across tasks.
