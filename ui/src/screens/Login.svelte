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
  <div class="login-card">
    <!-- Wordmark -->
    <div class="login-wordmark" aria-label="Xbox Remote">
      XBOX REMOTE
    </div>
    <p class="login-subtitle">Stream your Xbox console, anywhere.</p>

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
</div>

<style>
  .login-screen {
    display: flex;
    align-items: center;
    justify-content: center;
    min-height: 100vh;
    padding: var(--space-5);
    background: var(--bg);
  }

  .login-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: var(--space-5);
    width: 100%;
    max-width: 400px;
  }

  .login-wordmark {
    font-family: var(--font-mono);
    font-size: var(--text-xl);
    font-weight: 700;
    letter-spacing: 0.18em;
    color: var(--text);
    text-align: center;
    user-select: none;
  }

  .login-subtitle {
    margin: 0;
    font-family: var(--font-sans);
    font-size: var(--text-base);
    color: var(--text-dim);
    text-align: center;
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
    color: var(--text-dim);
    line-height: 1.6;
    max-width: 320px;
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
</style>
