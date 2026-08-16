<script lang="ts">
  interface Props {
    size?: number;
  }
  let { size = 52 }: Props = $props();
</script>

<svg
  class="mark"
  width={size}
  height={size}
  viewBox="0 0 1024 1024"
  role="img"
  aria-label="Kite"
>
  <rect x="6" y="6" width="1012" height="1012" rx="230" fill="#0E1116" stroke="#ffffff" stroke-opacity="0.10" stroke-width="8" />
  <path class="p" d="M512 162 L313 377 L512 377 Z" />
  <path class="s" d="M512 162 L711 377 L512 377 Z" />
  <path class="s" d="M313 377 L512 711 L512 377 Z" />
  <path class="p" d="M711 377 L512 711 L512 377 Z" />
  <path d="M512 162 L512 711 M313 377 L711 377" fill="none" stroke="#0E1116" stroke-width="14" stroke-linecap="round" />
  <path class="tail" d="M512 711 C 550 798 609 808 604 879 C 598 948 555 959 582 1002" fill="none" stroke-width="18" stroke-linecap="round" />
  <path class="p" d="M604 829 l22 27 l-22 27 l-22 -27 z" />
  <path class="p" d="M575 948 l19 24 l-19 24 l-19 -24 z" />
</svg>

<style>
  .mark { display: block; }
  .p { fill: var(--accent); }
  .s { fill: color-mix(in srgb, var(--accent) 70%, white); }
  .tail { stroke: color-mix(in srgb, var(--accent) 70%, white); }
</style>
