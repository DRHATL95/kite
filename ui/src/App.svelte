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
  import { authStore } from "$lib/stores/auth.svelte.js";
  import { connectionStore } from "$lib/stores/connection.svelte.js";
  import { updateStore } from "$lib/update/updateStore.svelte.js";

  import UpdateBanner from "./components/UpdateBanner.svelte";
  import Login       from "./screens/Login.svelte";
  import DeviceCode  from "./screens/DeviceCode.svelte";
  import ConsoleList from "./screens/ConsoleList.svelte";
  import Stream      from "./screens/Stream.svelte";

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

  onMount(() => {
    authStore.loadCached();
    updateStore.checkOnLaunch();
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
</div>

<style>
  .app-root {
    height: 100vh;
    background: var(--bg);
    color: var(--text);
  }
</style>
