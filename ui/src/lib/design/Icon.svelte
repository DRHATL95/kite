<script lang="ts" module>
  /**
   * Icon.svelte — Kite's glyph set, drawn in the LogoMark's language: a 20px
   * grid, straight edges with mitred joins, rhombus "kite" facets, and two-tone
   * fills where a glyph is solid (Play is literally the mark's facet pair).
   *
   * A path string is stroked; a { d, o } entry is filled at opacity o. Colour
   * is always currentColor, so an icon takes its button's text colour.
   */
  type Part = string | { d: string; o?: number };

  const ICONS = {
    play: [
      { d: "M6 3.5 L16.5 10 L6 10 Z" },
      { d: "M6 10 L16.5 10 L6 16.5 Z", o: 0.6 },
    ],
    "volume-off": ["M3 7.5 H6 L10.5 4 V16 L6 12.5 H3 Z", "M13.5 7.5 L18 12 M18 7.5 L13.5 12"],
    "volume-low": ["M3 7.5 H6 L10.5 4 V16 L6 12.5 H3 Z", "M13.5 7.5 L15.5 10 L13.5 12.5"],
    "volume-high": [
      "M3 7.5 H6 L10.5 4 V16 L6 12.5 H3 Z",
      "M13.5 7.5 L15.5 10 L13.5 12.5",
      "M16 5 L19 10 L16 15",
    ],
    settings: [
      "M10 2.5 L16.5 6.25 V13.75 L10 17.5 L3.5 13.75 V6.25 Z",
      "M12.5 10 A2.5 2.5 0 1 1 7.5 10 A2.5 2.5 0 1 1 12.5 10",
    ],
    close: ["M5 5 L15 15 M15 5 L5 15"],
    back: ["M16 10 H4 M9 5 L4 10 L9 15"],
    refresh: ["M16 10 A6 6 0 1 1 14.24 5.76", "M11 5.76 H14.24 V2.5"],
    fullscreen: ["M3 7.5 V3 H7.5 M12.5 3 H17 V7.5 M17 12.5 V17 H12.5 M7.5 17 H3 V12.5"],
    "fullscreen-exit": ["M7.5 3 V7.5 H3 M17 7.5 H12.5 V3 M12.5 17 V12.5 H17 M3 12.5 H7.5 V17"],
    immersive: ["M2.5 4.5 H17.5 V15.5 H2.5 Z", { d: "M10 7.5 L12.5 10 L10 12.5 L7.5 10 Z" }],
    eye: ["M1.5 10 L10 4.5 L18.5 10 L10 15.5 Z", "M12.25 10 A2.25 2.25 0 1 1 7.75 10 A2.25 2.25 0 1 1 12.25 10"],
    "eye-off": ["M1.5 10 L10 4.5 L18.5 10 L10 15.5 Z", "M3 17 L17 3"],
    keyframe: ["M10 2.5 L17.5 10 L10 17.5 L2.5 10 Z", { d: "M10 7 L13 10 L10 13 L7 10 Z", o: 0.6 }],
    clip: ["M2.5 4.5 H17.5 V15.5 H2.5 Z", { d: "M12.5 10 A2.5 2.5 0 1 1 7.5 10 A2.5 2.5 0 1 1 12.5 10" }],
    power: ["M10 2.5 V9", "M6 5 A6.5 6.5 0 1 0 14 5"],
    detect: [
      "M15.5 10 A5.5 5.5 0 1 1 4.5 10 A5.5 5.5 0 1 1 15.5 10",
      "M10 1.5 V5 M10 15 V18.5 M1.5 10 H5 M15 10 H18.5",
    ],
  } satisfies Record<string, Part[]>;

  export type IconName = keyof typeof ICONS;
</script>

<script lang="ts">
  interface Props {
    name: IconName;
    size?: number;
  }
  let { name, size = 16 }: Props = $props();
  const parts = $derived(ICONS[name] as Part[]);
</script>

<svg class="icon" width={size} height={size} viewBox="0 0 20 20" aria-hidden="true" focusable="false">
  {#each parts as part, i (i)}
    {#if typeof part === "string"}
      <path d={part} class="stroke" />
    {:else}
      <path d={part.d} fill="currentColor" fill-opacity={part.o ?? 1} />
    {/if}
  {/each}
</svg>

<style>
  .icon {
    display: inline-block;
    vertical-align: middle;
    flex-shrink: 0;
  }
  .stroke {
    fill: none;
    stroke: currentColor;
    stroke-width: 1.75;
    stroke-linejoin: miter;
    stroke-linecap: round;
  }
</style>
