<script lang="ts">
  import ThemeSwitcher from "../ThemeSwitcher.svelte";
  import Toggle from "$lib/design/Toggle.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
</script>

<div class="settings-row settings-row--stack">
  <div class="settings-row__text">
    <span class="settings-row__title">Theme</span>
    <span class="settings-row__desc">Switches instantly and is remembered.</span>
  </div>
  <ThemeSwitcher variant="chips" />
</div>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Keep running in the tray when closed</span>
    <span class="settings-row__desc">
      Closing the window hides Kite to the system tray instead of quitting —
      handy for audio-only. Restore it from the tray icon; use Quit Kite to exit.
    </span>
  </div>
  <Toggle checked={settings.minimizeToTray} label="" onchange={(on) => settings.setMinimizeToTray(on)} />
</div>
