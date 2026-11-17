<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";
  import { getReleases, type ReleaseNote } from "$lib/update/releaseNotes.js";
  import Button from "$lib/design/Button.svelte";
  import { authStore } from "$lib/stores/auth.svelte.js";

  interface Props {
    /** Close the settings view after a successful sign-out. */
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let appVersion = $state("");
  type LoadState = "loading" | "loaded" | "error";
  let loadState = $state<LoadState>("loading");
  let releases = $state<ReleaseNote[]>([]);

  let signingOut = $state(false);
  async function handleSignOut() {
    signingOut = true;
    await authStore.signOut();
    signingOut = false;
    // authState is now 'signedOut' → App routes back to Login. Close the view.
    onClose();
  }

  onMount(() => {
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
    getReleases()
      .then((r) => {
        releases = r;
        loadState = "loaded";
      })
      .catch(() => (loadState = "error"));
  });
</script>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Kite</span>
    <span class="settings-row__desc">
      {appVersion ? `Version ${appVersion}` : "Version unavailable"}
    </span>
  </div>
</div>

<div class="settings-row settings-row--stack">
  <div class="settings-row__text">
    <span class="settings-row__title">Release notes</span>
    <span class="settings-row__desc">What changed in each release.</span>
  </div>

  {#if loadState === "loading"}
    <p class="release-status">Loading…</p>
  {:else if loadState === "error"}
    <p class="release-status">Couldn't load release notes (offline, or the releases aren't reachable).</p>
  {:else if releases.length === 0}
    <p class="release-status">No releases yet.</p>
  {:else}
    <!-- Unkeyed: display-only list; a colliding key would throw each_key_duplicate. -->
    <ul class="release-list">
      {#each releases as r}
        <li class="release-note">
          <div class="release-note__head">
            <span class="release-note__version">{r.version}</span>
            {#if r.date}<span class="release-note__date">{r.date}</span>{/if}
          </div>
          {#if r.notes}<pre class="release-note__body">{r.notes}</pre>{/if}
        </li>
      {/each}
    </ul>
  {/if}
</div>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Sign out</span>
    <span class="settings-row__desc">
      Clears your saved Microsoft login from this device. You'll need to
      sign in again next time.
    </span>
  </div>
  <Button variant="danger" onclick={handleSignOut} disabled={signingOut}>
    {signingOut ? "Signing out…" : "Sign out"}
  </Button>
</div>

<style>
  .release-list {
    list-style: none;
    margin: 0;
    padding: 0;
    width: 100%;
    display: flex;
    flex-direction: column;
    gap: var(--space-3);
    max-height: 42vh;
    overflow-y: auto;
  }
  .release-note {
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    background: var(--surface-2);
  }
  .release-note__head {
    display: flex;
    align-items: baseline;
    justify-content: space-between;
    gap: var(--space-3);
  }
  .release-note__version {
    font-family: var(--font-display);
    font-size: var(--text-base);
    font-weight: 600;
    color: var(--text);
  }
  .release-note__date {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    flex-shrink: 0;
  }
  .release-note__body {
    margin: var(--space-2) 0 0;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    line-height: 1.5;
    color: var(--text-dim);
    white-space: pre-wrap;
    word-break: break-word;
  }
  .release-status {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }
</style>
