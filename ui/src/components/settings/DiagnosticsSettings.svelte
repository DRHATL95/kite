<script lang="ts">
  import Toggle from "$lib/design/Toggle.svelte";
  import Button from "$lib/design/Button.svelte";
  import { settings } from "$lib/stores/settings.svelte.js";
  import { setLogVerbosity, exportLogs, openLogDir } from "$lib/ipc/commands.js";
</script>

<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Show diagnostics HUD</span>
    <span class="settings-row__desc">
      Overlay a live diagnostics panel (video / network / packet stats + logs) on
      the stream, via the corner HUD button or the ` key. On by default for
      nightly builds, off for stable.
    </span>
  </div>
  <Toggle
    checked={settings.showDiagnosticsHud}
    label=""
    onchange={(on) => settings.setShowDiagnosticsHud(on)}
  />
</div>
<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Verbose logging</span>
    <span class="settings-row__desc">
      Capture full protocol detail (SDP/ICE/stats) to reproduce a bug. Off keeps
      logs lean. Logs are redacted of secrets and stored locally.
    </span>
  </div>
  <Toggle
    checked={settings.logVerbose}
    label=""
    onchange={(on) => { settings.setLogVerbose(on); void setLogVerbosity(on); }}
  />
</div>
<div class="settings-row">
  <div class="settings-row__text">
    <span class="settings-row__title">Export logs</span>
    <span class="settings-row__desc">Write a redacted log bundle and open its folder.</span>
  </div>
  <Button onclick={() => { void exportLogs(); void openLogDir(); }}>Export</Button>
</div>
