<script lang="ts">
  /**
   * App.svelte — Top-level router.
   *
   * Uses $derived to pick the active screen from the two stores:
   *   connecting | streaming | reconnecting | failed → Stream
   *   awaitingCode                                   → DeviceCode
   *   signedIn                                       → ConsoleList
   *   otherwise (unknown | signedOut)                → Login
   *
   * On mount, calls authStore.loadCached() once to restore cached tokens.
   * After disconnect(), connectionStore.state returns to 'idle' and
   * authStore.authState stays 'signedIn' → derived logic lands on ConsoleList.
   */

  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { authStore } from "$lib/stores/auth.svelte.js";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import { updateStore } from "$lib/update/updateStore.svelte.js";

  // Auto-return to console list 3 s after a connection failure, so the user
  // is never stranded on a blank stream screen with no obvious next step.
  $effect(() => {
    if (connectionStore.state === "failed") {
      const t = setTimeout(() => void connectionStore.disconnect(), 3000);
      return () => clearTimeout(t);
    }
  });

  // Attach/detach the clip buffer based on settings + live stream.
  // Re-runs whenever the stream, session state, or clip settings change.
  $effect(() => {
    const stream = connectionStore.mediaStream;
    const streaming = connectionStore.state === "streaming";
    const c = settingsStore.clip;
    if (c.enabled && streaming && stream) {
      clipStore.attach(stream, { lengthSec: c.lengthSec, quality: c.quality });
    } else {
      clipStore.detach();
    }
    return () => clipStore.detach();
  });

  import UpdateBanner from "./components/UpdateBanner.svelte";
  import Login       from "./screens/Login.svelte";
  import DeviceCode  from "./screens/DeviceCode.svelte";
  import ConsoleList from "./screens/ConsoleList.svelte";
  import Stream      from "./screens/Stream.svelte";
  import { settingsStore } from "$lib/stores/settings.svelte.js";
  import { clipStore } from "$lib/stores/clip.svelte.js";
  import { uiStore } from "$lib/stores/ui.svelte.js";
  import Settings from "./screens/Settings.svelte";
  import Toast from "./components/Toast.svelte";

  // ── Routing ────────────────────────────────────────────────────────────────────

  type Screen = "login" | "deviceCode" | "consoleList" | "stream";

  const activeScreen = $derived((): Screen => {
    const cs = connectionStore.state;
    if (cs === "connecting" || cs === "streaming" || cs === "reconnecting" || cs === "failed") {
      return "stream";
    }
    if (authStore.authState === "awaitingCode") return "deviceCode";
    if (authStore.authState === "signedIn")     return "consoleList";
    return "login";
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Runtime app version (CI-injected for nightlies); empty until resolved. */
  let appVersion = $state("");

  onMount(() => {
    authStore.loadCached();
    updateStore.checkOnLaunch();
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
  });
</script>

<div class="app-root">
  <UpdateBanner />
  {#if activeScreen() === "stream"}
    <Stream onDisconnect={() => connectionStore.disconnect()} />
  {:else if activeScreen() === "deviceCode"}
    <DeviceCode />
  {:else if activeScreen() === "consoleList"}
    <ConsoleList onConnect={(c) => connectionStore.connect(c)} />
  {:else}
    <Login />
  {/if}

  <!-- Settings modal (overlay; reachable from any screen) -->
  {#if uiStore.settingsOpen}
    <Settings onClose={() => uiStore.closeSettings()} />
  {/if}

  <!-- Toast host -->
  <Toast />

  <!-- Global settings gear on non-stream screens (stream screen has its own in the controls bar) -->
  {#if activeScreen() !== "stream"}
    <button class="app-gear" aria-label="Settings" title="Settings" onclick={() => uiStore.openSettings()}>⚙</button>
  {/if}

  {#if appVersion && activeScreen() !== "stream"}
    <span class="app-version">v{appVersion}</span>
  {/if}
</div>

<style>
  .app-root {
    height: 100vh;
    background: var(--bg);
    color: var(--text);
  }

  /* Quiet version label; hidden during streaming so it never overlays video. */
  .app-version {
    position: fixed;
    right: var(--space-3);
    bottom: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    opacity: 0.7;
    pointer-events: none;
    user-select: none;
  }

  /* Quiet settings gear, top-right; hidden during streaming. */
  .app-gear {
    position: fixed;
    top: var(--space-3);
    right: var(--space-3);
    z-index: 30;
    background: transparent;
    border: none;
    color: var(--text-dim);
    font-size: var(--text-lg);
    line-height: 1;
    cursor: pointer;
    opacity: 0.7;
    transition: opacity 120ms ease, color 120ms ease;
  }

  .app-gear:hover { opacity: 1; color: var(--text); }
  .app-gear:focus-visible { box-shadow: var(--focus-ring); border-radius: var(--radius-sm); }
</style>
