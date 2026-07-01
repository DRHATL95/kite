<script lang="ts">
  import Toggle from "$lib/design/Toggle.svelte";
  import Button from "$lib/design/Button.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { updateStore } from "$lib/update/updateStore.svelte.js";

  function handleChannelToggle(nightly: boolean) {
    void updateStore.switchChannel(nightly ? "nightly" : "stable");
  }
</script>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Nightly builds</span>
    <span class="settings-row__desc">
      Get pre-release updates ahead of stable. Off = stable releases only.
    </span>
  </div>
  <Toggle checked={settings.updateChannel === "nightly"} label="" onchange={handleChannelToggle} />
</div>
<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Check for updates</span>
    <span class="settings-row__desc">
      {#if updateStore.available}
        Update available: {updateStore.available.version}
      {:else if updateStore.upToDate}
        You're on the latest {settings.updateChannel} build.
      {:else}
        Re-check the {settings.updateChannel} channel now.
      {/if}
    </span>
  </div>
  <Button onclick={() => void updateStore.checkNow()} disabled={updateStore.checking}>
    {updateStore.checking ? "Checking…" : "Check"}
  </Button>
</div>
