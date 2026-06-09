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
  import Panel from "$lib/design/Panel.svelte";

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
  <div class="login-hero">
    <div class="xbox-logo" aria-hidden="true">
      <svg viewBox="0 0 64 64" width="64" height="64" xmlns="http://www.w3.org/2000/svg">
        <circle cx="32" cy="32" r="30" fill="#107C10" />
        <path
          d="M32 10 C20 10 14 22 14 22 C14 22 22 14 32 22 C42 14 50 22 50 22 C50 22 44 10 32 10Z"
          fill="white"
          opacity="0.9"
        />
        <path
          d="M32 22 C22 14 14 22 14 22 C10 28 10 40 16 48 C20 54 26 56 32 54 C32 54 28 46 22 36 C28 28 32 22 32 22Z"
          fill="white"
          opacity="0.9"
        />
        <path
          d="M32 22 C42 14 50 22 50 22 C54 28 54 40 48 48 C44 54 38 56 32 54 C32 54 36 46 42 36 C36 28 32 22 32 22Z"
          fill="white"
          opacity="0.9"
        />
      </svg>
    </div>
    <h1 class="login-title">Xbox Remote</h1>
    <p class="login-subtitle">Stream your Xbox console, anywhere.</p>
  </div>

  <Panel title="Sign in">
    <div class="login-body">
      {#if loading}
        <p class="login-status">Checking saved sign-in…</p>
        <div class="spinner" role="status" aria-label="Loading"></div>
      {:else}
        <p class="login-description">
          Sign in with your Microsoft account to discover and connect to your Xbox consoles.
        </p>

        <Button onclick={handleSignIn} disabled={loading}>
          Sign in to Xbox
        </Button>

        {#if authStore.error}
          <p class="login-error" role="alert">{authStore.error}</p>
        {/if}
      {/if}
    </div>
  </Panel>
</div>

<style>
  .login-screen {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    gap: var(--space-5);
    padding: var(--space-5);
    background: var(--color-bg);
  }

  .login-hero {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-3);
    text-align: center;
  }

  .xbox-logo {
    filter: drop-shadow(0 4px 12px rgba(82, 176, 67, 0.4));
  }

  .login-title {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-xl);
    font-weight: 700;
    color: var(--color-text);
    letter-spacing: -0.01em;
  }

  .login-subtitle {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    color: var(--color-text-dim);
  }

  .login-body {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-4);
    min-width: 280px;
    text-align: center;
  }

  .login-description {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-text-dim);
    line-height: 1.6;
    max-width: 320px;
  }

  .login-status {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-text-dim);
  }

  .login-error {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--color-danger);
    background: color-mix(in srgb, var(--color-danger) 10%, transparent);
    border: 1px solid color-mix(in srgb, var(--color-danger) 25%, transparent);
    border-radius: var(--radius-sm);
    padding: var(--space-2) var(--space-3);
    text-align: left;
    width: 100%;
    box-sizing: border-box;
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
</style>
