<script lang="ts">
  /**
   * DeviceCode.svelte — Browser sign-in waiting screen.
   *
   * Rendered when authStore.authState === 'awaitingCode'. The authorization-code
   * (+ PKCE) flow opens the user's browser to the Microsoft consent page; a Rust
   * background task catches the localhost loopback redirect and completes
   * sign-in. This screen shows a waiting state, a manual "Open sign-in page"
   * button (in case the auto-open failed), and polls checkAuthStatus() until
   * sign-in completes.
   *
   * Opening the page uses the open_external_url backend command (sanitized env
   * on Linux so it works inside an AppImage). window.open is a no-op in
   * WebKitGTK, so it must NOT be used here.
   *
   * Props: none. State transitions are driven by authStore.authState.
   */

  import { openExternalUrl } from "$lib/ipc/commands.js";
  import { logger } from "$lib/log/logger.js";
  import { authStore } from "$lib/stores/auth.svelte.js";
  import Button from "$lib/design/Button.svelte";
  import Panel from "$lib/design/Panel.svelte";

  // The authorize URL the backend prepared for this sign-in.
  let signInUrl = $derived(authStore.signInUrl ?? "");

  // Show the failure variant (error + retry) when a sign-in attempt failed.
  let failed = $derived(authStore.authState === "failed");

  let openError = $state<string | null>(null);
  let urlCopied = $state(false);

  // ── Polling lifecycle ────────────────────────────────────────────────────────
  // Poll only while actually awaiting sign-in. Keying the effect on authState
  // means it restarts the loop when the user retries (failed → awaitingCode) and
  // stops once we leave that state; cleanup cancels the loop on destroy.
  $effect(() => {
    if (authStore.authState !== "awaitingCode") return;
    const cancel = authStore.startPollingLoop();
    return cancel;
  });

  // ── Actions ───────────────────────────────────────────────────────────────────

  async function openSignIn() {
    openError = null;
    try {
      await openExternalUrl(signInUrl);
    } catch (e) {
      openError = `Couldn't open the browser automatically — use "Copy link" and open it manually.`;
      logger.error("auth", `open sign-in failed: ${e}`);
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(signInUrl);
      urlCopied = true;
      setTimeout(() => {
        urlCopied = false;
      }, 2000);
    } catch {
      // clipboard API unavailable — the link below is hand-selectable as a fallback
    }
  }

  // Retry a failed sign-in: starts a fresh flow (new authorize URL + loopback)
  // and, by returning authState to 'awaitingCode', restarts the polling effect.
  async function retry() {
    await authStore.signIn();
  }

  // Abandon the attempt and return to the login screen.
  function back() {
    authStore.cancelSignIn();
  }
</script>

<div class="device-code-screen">
  <Panel title={failed ? "Sign-in failed" : "Sign in with Microsoft"}>
    {#if failed}
      <!-- ── Failure variant ───────────────────────────────────────────────── -->
      <div class="device-code-body">
        <p class="instruction">
          We couldn't finish signing you in. Your browser login worked, but the
          app couldn't complete the secure token exchange with Microsoft.
        </p>

        {#if authStore.error}
          <p class="error-message" role="alert">{authStore.error}</p>
        {/if}

        <div class="url-section">
          <Button onclick={retry}>Try again</Button>
          <Button variant="ghost" onclick={back}>Back to start</Button>
        </div>
      </div>
    {:else}
      <!-- ── Waiting variant ───────────────────────────────────────────────── -->
      <div class="device-code-body">
        <p class="instruction">
          We've opened your browser to sign in. Approve access there and the app
          will connect automatically — nothing to type here.
        </p>

        <!-- ── Sign-in action ───────────────────────────────────────────────── -->
        <div class="url-section">
          <Button onclick={openSignIn} disabled={!signInUrl}>
            Open sign-in page
          </Button>

          {#if openError}
            <p class="error-message" role="alert">{openError}</p>
          {/if}

          <div class="url-copy-row">
            <span class="url-text" title={signInUrl}>{signInUrl}</span>
            <Button variant="ghost" onclick={copyUrl} disabled={!signInUrl}>
              {urlCopied ? "Copied!" : "Copy link"}
            </Button>
          </div>
        </div>

        <!-- ── Waiting indicator ─────────────────────────────────────────────── -->
        <div class="waiting-indicator">
          <span class="live-dot" role="status" aria-label="Waiting for sign-in"></span>
          <p class="waiting-text">Waiting for you to finish signing in…</p>
        </div>
      </div>
    {/if}
  </Panel>
</div>

<style>
  .device-code-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-5);
    background: transparent;
  }

  .device-code-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    min-width: 320px;
    max-width: 480px;
    text-align: center;
  }

  .instruction {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    color: var(--text-dim);
  }

  /* ── Sign-in action ───────────────────────────────────────────────────────── */

  .url-section {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    width: 100%;
  }

  .url-copy-row {
    display: flex;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
    background: var(--surface-2);
    border: 1px solid var(--border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }

  .url-text {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
    /* Selectable so the full URL can be hand-copied even when the webview's
       clipboard API is unavailable (Linux/WebKitGTK) and "Copy link" silently
       fails — text-overflow only truncates visually, selection grabs it all. */
    user-select: all;
  }

  /* ── Waiting indicator ────────────────────────────────────────────────────── */

  .waiting-indicator {
    display: flex;
    align-items: center;
    gap: var(--space-2);
  }

  .live-dot {
    display: inline-block;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--accent);
    animation: pulse 1.8s ease-in-out infinite;
    flex-shrink: 0;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.3; }
  }

  .waiting-text {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  /* ── Error ────────────────────────────────────────────────────────────────── */

  .error-message {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    width: 100%;
    box-sizing: border-box;
    text-align: left;
  }
</style>
