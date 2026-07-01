<script lang="ts">
  import Button from "$lib/design/Button.svelte";
  import { authStore } from "$lib/stores/auth.svelte.js";

  interface Props {
    /** Close the settings view after a successful sign-out. */
    onClose: () => void;
  }
  let { onClose }: Props = $props();

  let signingOut = $state(false);

  async function handleSignOut() {
    signingOut = true;
    await authStore.signOut();
    signingOut = false;
    // authState is now 'signedOut' → App routes back to Login. Close the view.
    onClose();
  }
</script>

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
