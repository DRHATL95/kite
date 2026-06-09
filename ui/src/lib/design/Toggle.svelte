<script lang="ts">
  /**
   * Toggle.svelte — Accessible boolean toggle (checkbox-backed switch).
   *
   * Usage:
   *   <Toggle bind:checked={showHud} label="Show HUD" />
   *   <Toggle bind:checked={value} label="Option" disabled />
   */

  interface Props {
    /** Reactive boolean value — use bind:checked. */
    checked: boolean;
    /** Visible label text. */
    label: string;
    /** Whether the control is non-interactive. */
    disabled?: boolean;
    /** Change handler (receives new boolean value). */
    onchange?: (value: boolean) => void;
  }

  let {
    checked = $bindable(false),
    label,
    disabled = false,
    onchange,
  }: Props = $props();

  function handleChange(e: Event) {
    const target = e.target as HTMLInputElement;
    checked = target.checked;
    onchange?.(target.checked);
  }
</script>

<label class="toggle" class:toggle--disabled={disabled}>
  <input
    type="checkbox"
    class="toggle__input"
    {checked}
    {disabled}
    onchange={handleChange}
    aria-checked={checked}
  />
  <span class="toggle__track" aria-hidden="true">
    <span class="toggle__thumb"></span>
  </span>
  <span class="toggle__label">{label}</span>
</label>

<style>
  .toggle {
    display: inline-flex;
    align-items: center;
    gap: var(--space-3);
    cursor: pointer;
    user-select: none;
    font-family: var(--font-sans);
    font-size: var(--text-sm);
    color: var(--text);
  }

  .toggle--disabled {
    opacity: 0.45;
    cursor: not-allowed;
  }

  /* Visually hidden native checkbox — still keyboard + screen-reader accessible */
  .toggle__input {
    position: absolute;
    width: 1px;
    height: 1px;
    padding: 0;
    margin: -1px;
    overflow: hidden;
    clip: rect(0, 0, 0, 0);
    white-space: nowrap;
    border: 0;
  }

  /* Focus ring on the track when the hidden input is focused */
  .toggle__input:focus-visible + .toggle__track {
    box-shadow: var(--focus-ring);
  }

  /* Track — off state */
  .toggle__track {
    position: relative;
    display: inline-block;
    width: 36px;
    height: 20px;
    border-radius: 10px;
    background: var(--border);
    transition: background 150ms ease;
    flex-shrink: 0;
  }

  /* Track — on state: accent */
  .toggle__input:checked + .toggle__track {
    background: var(--accent);
  }

  /* Thumb */
  .toggle__thumb {
    position: absolute;
    top: 2px;
    left: 2px;
    width: 16px;
    height: 16px;
    border-radius: 50%;
    background: var(--text);
    box-shadow: var(--shadow-sm);
    transition: transform 150ms ease;
  }

  .toggle__input:checked + .toggle__track .toggle__thumb {
    transform: translateX(16px);
  }

  .toggle__label {
    line-height: 1.4;
  }
</style>
