<script lang="ts">
  /**
   * DeviceCode.svelte — Device-code display and polling screen.
   *
   * Rendered when authStore.authState === 'awaitingCode'.
   * Displays user_code prominently and verification_uri with open/copy options.
   *
   * Starts authStore.startPollingLoop() on mount; cancels it in the $effect
   * cleanup so the interval is never leaked when the component is destroyed.
   *
   * Note: @tauri-apps/plugin-shell is not installed in this project.
   * URL opening falls back to window.open() (works in Tauri WebView).
   * A "Copy URL" button is provided as a reliable alternative.
   *
   * Props: none.
   */

  import { onMount } from "svelte";
  import { authStore } from "$lib/stores/auth.svelte.js";
  import Button from "$lib/design/Button.svelte";
  import Panel from "$lib/design/Panel.svelte";

  // Reactive access to deviceCode fields. DeviceCodeInfo uses snake_case
  // (no serde rename attributes) — fields are user_code and verification_uri.
  let userCode = $derived(authStore.deviceCode?.user_code ?? "");
  let verificationUri = $derived(authStore.deviceCode?.verification_uri ?? "");

  let codeCopied = $state(false);
  let urlCopied = $state(false);

  // ── Polling lifecycle ────────────────────────────────────────────────────────
  // $effect runs after mount; its cleanup callback fires when the component
  // is destroyed — this guarantees the polling loop is always cancelled.
  $effect(() => {
    const cancel = authStore.startPollingLoop(3000);
    return cancel;
  });

  // ── Actions ───────────────────────────────────────────────────────────────────

  function openUrl() {
    // Tauri WebView supports window.open with _blank for external URLs.
    window.open(verificationUri, "_blank");
  }

  async function copyCode() {
    try {
      await navigator.clipboard.writeText(userCode);
      codeCopied = true;
      setTimeout(() => { codeCopied = false; }, 2000);
    } catch {
      // clipboard API unavailable — silently ignore
    }
  }

  async function copyUrl() {
    try {
      await navigator.clipboard.writeText(verificationUri);
      urlCopied = true;
      setTimeout(() => { urlCopied = false; }, 2000);
    } catch {
      // clipboard API unavailable — silently ignore
    }
  }
</script>

<div class="device-code-screen">
  <Panel title="Sign in with Microsoft">
    <div class="device-code-body">
      <p class="instruction">
        Go to the sign-in page and enter the code below:
      </p>

      <!-- ── Code display ─────────────────────────────────────────────────── -->
      <div class="code-block">
        <button
          class="code-display"
          onclick={copyCode}
          title="Click to copy code"
          aria-label="Device code: {userCode}. Click to copy."
        >
          {userCode || "Loading…"}
        </button>
        <p class="code-hint">Click the code to copy it</p>
        {#if codeCopied}
          <p class="copy-feedback" role="status">Copied!</p>
        {/if}
      </div>

      <!-- ── URL section ──────────────────────────────────────────────────── -->
      <div class="url-section">
        <Button onclick={openUrl} disabled={!verificationUri}>
          Open sign-in page
        </Button>

        <div class="url-copy-row">
          <span class="url-text" title={verificationUri}>{verificationUri}</span>
          <Button variant="ghost" onclick={copyUrl} disabled={!verificationUri}>
            {urlCopied ? "Copied!" : "Copy URL"}
          </Button>
        </div>
      </div>

      <!-- ── Waiting indicator ─────────────────────────────────────────────── -->
      <div class="waiting-indicator">
        <div class="spinner" role="status" aria-label="Waiting for sign-in"></div>
        <p class="waiting-text">Waiting for you to sign in…</p>
      </div>

      {#if authStore.error}
        <p class="error-message" role="alert">{authStore.error}</p>
      {/if}
    </div>
  </Panel>
</div>

<style>
  .device-code-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-5);
    background: var(--color-bg);
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
    color: var(--color-text-dim);
  }

  /* ── Code display ─────────────────────────────────────────────────────────── */

  .code-block {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
    width: 100%;
  }

  .code-display {
    /* Styled as a large, clickable display — not a typical button shape */
    display: block;
    width: 100%;
    padding: var(--space-5) var(--space-4);
    background: var(--color-surface-2);
    border: 2px solid var(--color-accent);
    border-radius: var(--radius-md);
    font-family: var(--font-mono);
    font-size: 2.4rem;
    font-weight: 800;
    letter-spacing: 0.18em;
    color: var(--color-accent);
    text-align: center;
    cursor: pointer;
    transition: background var(--transition-fast), border-color var(--transition-fast);
    user-select: all;
  }

  .code-display:hover {
    background: color-mix(in srgb, var(--color-accent) 10%, var(--color-surface-2));
    border-color: var(--color-accent-hover);
  }

  .code-display:focus-visible {
    outline: 2px solid var(--color-focus-ring);
    outline-offset: 2px;
  }

  .code-hint {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
  }

  .copy-feedback {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-xs);
    color: var(--color-success);
    font-weight: 600;
  }

  /* ── URL section ──────────────────────────────────────────────────────────── */

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
    background: var(--color-surface-2);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
  }

  .url-text {
    flex: 1;
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    color: var(--color-text-dim);
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    min-width: 0;
  }

  /* ── Waiting indicator ────────────────────────────────────────────────────── */

  .waiting-indicator {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-2);
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid var(--color-border);
    border-top-color: var(--color-accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  .waiting-text {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-text-dim);
  }

  /* ── Error ────────────────────────────────────────────────────────────────── */

  .error-message {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    width: 100%;
    box-sizing: border-box;
    text-align: left;
  }
</style>
