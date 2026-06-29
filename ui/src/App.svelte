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

  // Attach/detach the browser clip buffer (EncodedTap / ClipBuffer) based on
  // settings + live stream.  Browser-only: native mode has no MediaStream to
  // attach to — the engine ClipRing records continuously on the Rust side.
  // Re-runs whenever the stream, session state, or clip settings change.
  $effect(() => {
    if (connectionStore.nativeMode) return; // native: engine handles clip recording
    const stream = connectionStore.mediaStream;
    const streaming = connectionStore.state === "streaming";
    const c = settings.clip;
    if (c.enabled && streaming && stream) {
      clipStore.attach(stream, { lengthSec: c.lengthSec, quality: c.quality });
    } else {
      clipStore.detach();
    }
    return () => clipStore.detach();
  });

  $effect(() => {
    const stop = initLogging();
    void setLogVerbosity(settings.logVerbose); // apply persisted choice
    return stop;
  });

  import UpdateBanner from "./components/UpdateBanner.svelte";
  import Login       from "./screens/Login.svelte";
  import DeviceCode  from "./screens/DeviceCode.svelte";
  import ConsoleList from "./screens/ConsoleList.svelte";
  import Stream      from "./screens/Stream.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { clipStore } from "$lib/stores/clip.svelte.js";
  import Toast from "./components/Toast.svelte";
  import { initLogging } from "$lib/log/logger.js";
  import { setLogVerbosity } from "$lib/ipc/commands.js";

  // ── Routing ────────────────────────────────────────────────────────────────────

  type Screen = "login" | "deviceCode" | "consoleList" | "stream";

  const activeScreen = $derived((): Screen => {
    const cs = connectionStore.state;
    if (cs === "connecting" || cs === "streaming" || cs === "reconnecting" || cs === "failed") {
      return "stream";
    }
    // 'failed' stays on the DeviceCode screen so the error + retry are shown;
    // bouncing to Login would re-run loadCached() and wipe authStore.error.
    if (authStore.authState === "awaitingCode" || authStore.authState === "failed") {
      return "deviceCode";
    }
    if (authStore.authState === "signedIn") return "consoleList";
    return "login";
  });

  // ── Lifecycle ─────────────────────────────────────────────────────────────────

  /** Runtime app version (CI-injected for nightlies); empty until resolved. */
  let appVersion = $state("");

  onMount(() => {
    // Resolve the connection backend (native vs browser) before any connect.
    // Sets connectionStore.backendReady = true when done.
    void connectionStore.init();

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
    <ConsoleList
      onConnect={(c) => {
        // Guard: do not connect before the backend has been selected.
        if (!connectionStore.backendReady) return;
        void connectionStore.connect(c);
      }}
    />
  {:else}
    <Login />
  {/if}

  <!-- Toast host (clip-saved notifications) -->
  <Toast />

  {#if appVersion && activeScreen() !== "stream"}
    <span class="app-version">v{appVersion}</span>
  {/if}
</div>

<style>
  .app-root {
    height: 100vh;
    background: transparent; /* body::before paints the themed atmosphere */
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

</style>
