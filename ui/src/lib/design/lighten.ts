/**
 * lighten — mix `amt` (0..1) of white into a #rrggbb hex color.
 *
 * Canonical expression of the app-icon tint rule. `lighten(accent, 0.30)` is
 * numerically identical to the CSS `color-mix(in srgb, var(--accent) 70%, white)`
 * used by LogoMark.svelte — keep the two in sync.
 */
export function lighten(hex: string, amt: number): string {
  const n = parseInt(hex.slice(1), 16);
  const mix = (c: number) => Math.round(c + (255 - c) * amt);
  const r = mix((n >> 16) & 255);
  const g = mix((n >> 8) & 255);
  const b = mix(n & 255);
  return "#" + ((1 << 24) | (r << 16) | (g << 8) | b).toString(16).slice(1);
}
