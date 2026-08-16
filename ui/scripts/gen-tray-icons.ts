import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";
import { Resvg } from "@resvg/resvg-js";
import { THEMES } from "../src/lib/design/themes.js";
import { lighten } from "../src/lib/design/lighten.js";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const svg = readFileSync(resolve(repoRoot, "icons/kite.svg"), "utf8");
const outDir = resolve(repoRoot, "icons/tray");
mkdirSync(outDir, { recursive: true });

for (const theme of THEMES) {
  const accent = theme.swatch[2];
  const secondary = lighten(accent, 0.3);
  const tinted = svg
    .replaceAll("#38BDF8", accent)
    .replaceAll("#2DD4BF", secondary);
  const png = new Resvg(tinted, { fitTo: { mode: "width", value: 64 } })
    .render()
    .asPng();
  const out = resolve(outDir, `kite-${theme.id}.png`);
  writeFileSync(out, png);
  console.log(`wrote icons/tray/kite-${theme.id}.png (${png.length} bytes)`);
}
