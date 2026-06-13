<script lang="ts">
  /**
   * Login.svelte — Sign-in call-to-action screen.
   *
   * On mount, calls authStore.loadCached() to try tokens from the OS keychain.
   * If already signed in, the parent App should watch authStore.authState and
   * navigate to ConsoleList.  If not, shows the "Sign in to Xbox" button which
   * calls authStore.signIn() to start the device-code flow.
   *
   * Props: none.
   * State transitions driven entirely by authStore.authState.
   */

  import { onMount } from "svelte";
  import { authStore } from "$lib/stores/auth.svelte.js";
  import Button from "$lib/design/Button.svelte";
  import ThemeSwitcher from "../components/ThemeSwitcher.svelte";

  let loading = $state(false);

  onMount(async () => {
    loading = true;
    await authStore.loadCached();
    loading = false;
  });

  async function handleSignIn() {
    loading = true;
    await authStore.signIn();
    loading = false;
  }
</script>

<div class="login-screen">
  <div class="login-card">
    <!-- Kicker -->
    <div class="login-kicker" style="--i: 0;">
      <span class="kicker-dot" aria-hidden="true"></span>
      <span>CLOUD REMOTE PLAY</span>
    </div>

    <!-- Wordmark -->
    <h1 class="brand" style="--i: 1;" aria-label="Xbox Remote">
      <span>XBOX</span><span class="brand__accent">REMOTE</span>
    </h1>

    <p class="login-subtitle" style="--i: 2;">Stream your console. Anywhere on your network.</p>

    <!-- Sign-in card -->
    <div class="signin" style="--i: 3;">
      {#if loading}
        <p class="login-status">Checking saved sign-in…</p>
        <div class="spinner" role="status" aria-label="Loading"></div>
      {:else}
        <p class="login-description">
          Sign in with your Microsoft account to discover and connect to your Xbox consoles.
        </p>

        <Button onclick={handleSignIn} disabled={loading} class="signin__btn">
          Sign in to Xbox
        </Button>

        {#if authStore.error}
          <p class="login-error" role="alert">{authStore.error}</p>
        {/if}
      {/if}
    </div>

    <!-- Theme picker — discoverable from the first screen -->
    <div class="login-theme" style="--i: 4;">
      <span class="login-theme__label">THEME</span>
      <ThemeSwitcher variant="dots" />
    </div>
  </div>
</div>

<style>
  .login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-5);
    background: transparent;
  }

  .login-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    max-width: 440px;
    text-align: center;
  }

  /* Staggered entrance — each child sets --i for its delay. */
  .login-card > * {
    animation: rise 700ms var(--ease-out) backwards;
    animation-delay: calc(var(--i, 0) * 90ms + 60ms);
  }

  @keyframes rise {
    from { opacity: 0; transform: translateY(14px); }
    to   { opacity: 1; transform: translateY(0); }
  }

  /* ── Kicker ─────────────────────────────────────────────────────────── */
  .login-kicker {
    display: inline-flex;
    align-items: center;
    gap: var(--space-2);
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.22em;
    color: var(--text-dim);
  }

  .kicker-dot {
    width: 7px;
    height: 7px;
    border-radius: 50%;
    background: var(--accent);
    box-shadow: 0 0 10px var(--accent);
    animation: pulse 2s ease-in-out infinite;
  }

  @keyframes pulse {
    0%, 100% { opacity: 1; }
    50% { opacity: 0.35; }
  }

  /* ── Wordmark ───────────────────────────────────────────────────────── */
  .brand {
    margin: 0;
    display: flex;
    gap: 0.28em;
    font-family: var(--font-display);
    font-weight: 700;
    font-size: var(--text-3xl);
    letter-spacing: 0.04em;
    line-height: 1;
    color: var(--text);
    user-select: none;
  }

  .brand__accent {
    color: var(--accent);
    text-shadow: 0 0 24px color-mix(in srgb, var(--accent) 45%, transparent);
  }

  .login-subtitle {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    color: var(--text-dim);
    max-width: 340px;
    line-height: 1.5;
  }

  /* ── Sign-in card ───────────────────────────────────────────────────── */
  .signin {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    width: 100%;
    margin-top: var(--space-2);
    padding: var(--space-5);
    background: color-mix(in srgb, var(--surface) 80%, transparent);
    border: 1px solid var(--border);
    border-radius: var(--radius-lg);
    box-shadow: var(--shadow-md);
    backdrop-filter: blur(10px);
    -webkit-backdrop-filter: blur(10px);
  }

  .login-description {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
    line-height: 1.6;
    max-width: 320px;
  }

  /* Make the sign-in button full-width and a touch taller. */
  .signin :global(.signin__btn) {
    width: 100%;
    padding: var(--space-3) var(--space-4);
    font-size: var(--text-base);
  }

  .login-status {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text-dim);
  }

  .login-error {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--bad);
    background: color-mix(in srgb, var(--bad) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--bad) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    text-align: left;
    width: 100%;
    box-sizing: border-box;
  }

  .spinner {
    width: 24px;
    height: 24px;
    border: 3px solid var(--border);
    border-top-color: var(--accent);
    border-radius: 50%;
    animation: spin 0.8s linear infinite;
  }

  @keyframes spin {
    to { transform: rotate(360deg); }
  }

  /* ── Theme picker row ───────────────────────────────────────────────── */
  .login-theme {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    margin-top: var(--space-3);
  }

  .login-theme__label {
    font-family: var(--font-mono);
    font-size: var(--text-xs);
    letter-spacing: 0.22em;
    color: var(--text-dim);
  }
</style>
