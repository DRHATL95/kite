<script lang="ts">
  import { onMount } from "svelte";
  import { getVersion } from "@tauri-apps/api/app";

  let appVersion = $state("");
  onMount(() => {
    getVersion()
      .then((v) => (appVersion = v))
      .catch(() => {});
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
