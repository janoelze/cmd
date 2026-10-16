// Draws the phone web client's home-screen icons (apps/web/public) from the
// app icon's sources, apps/desktop/build/icon.icon (its background gradient and
// glyph.svg; the release icon, not build/dev), in headless Chromium. Run it
// after the icon changes and commit the PNGs: `node scripts/web-icons.mjs`.
// `--dev` draws only the red set, with scripts/make-icons.mjs's dev gradient, into
// scripts/phone-origin/icons (and a manifest named "cmd dev"): phone:serve serves those
// in place of the real ones, so the dev origin's Home Screen app looks like cmd dev.
//   apple-touch-icon.png  180, full bleed and opaque (iOS rounds it itself)
//   icon-192/512.png      the rounded tile, for browsers and "any" purpose
//   icon-maskable-512.png full bleed, the glyph well inside the 80% safe circle
//   favicon.svg           the rounded tile as a vector
import fs from "node:fs";
import path from "node:path";
import { chromium } from "playwright";

const root = path.resolve(import.meta.dirname, "..");
const src = path.join(root, "apps/desktop/build/icon.icon");
const dev = process.argv.includes("--dev");
const out = path.join(root, dev ? "scripts/phone-origin/icons" : "apps/web/public");
fs.mkdirSync(out, { recursive: true });

const spec = JSON.parse(fs.readFileSync(path.join(src, "icon.json"), "utf8"));
const rgb = (s) => {
  const [r, g, b] = s.replace(/^srgb:/, "").split(",").map(Number);
  return `#${[r, g, b].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;
};
// The dev gradient is make-icons.mjs's.
const [top, bottom] = (dev ? ["srgb:0.86000,0.20000,0.18000,1.00000", "srgb:0.52000,0.06000,0.06000,1.00000"] : spec.fill["linear-gradient"]).map(rgb);
const glyph = fs.readFileSync(path.join(src, "Assets/glyph.svg"), "utf8").match(/ d="([^"]+)"/)[1];

/** The icon as SVG on a 1024 canvas: `rounded` gives the tile its corners, `scale` the glyph's share of the side. */
function svg({ rounded, scale }) {
  const g = 1024 * scale;
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 1024 1024">
<defs><linearGradient id="bg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="${top}"/><stop offset="1" stop-color="${bottom}"/></linearGradient>
<linearGradient id="fg" x1="0" y1="0" x2="0" y2="1"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#e4e4e8"/></linearGradient>
<filter id="sh" x="-20%" y="-20%" width="140%" height="140%"><feDropShadow dx="0" dy="${g * 0.02}" stdDeviation="${g * 0.025}" flood-opacity="0.45"/></filter></defs>
<rect width="1024" height="1024" ${rounded ? 'rx="229"' : ""} fill="url(#bg)"/>
<g transform="translate(512 512) scale(${g / 486})" filter="url(#sh)"><path fill="url(#fg)" d="${glyph}"/></g>
</svg>`;
}

// glyph.svg is 486 of the icon's 1024 points (icon.json scales it 1:1).
const TILE = 486 / 1024;
const icons = [
  { file: "apple-touch-icon.png", size: 180, rounded: false, scale: TILE },
  { file: "icon-192.png", size: 192, rounded: true, scale: TILE },
  { file: "icon-512.png", size: 512, rounded: true, scale: TILE },
  { file: "icon-maskable-512.png", size: 512, rounded: false, scale: 0.4 },
];

if (dev) {
  const manifest = JSON.parse(fs.readFileSync(path.join(root, "apps/web/public/manifest.webmanifest"), "utf8"));
  fs.writeFileSync(path.join(out, "manifest.webmanifest"), JSON.stringify({ ...manifest, name: "cmd dev", short_name: "cmd dev" }, null, 2) + "\n");
}
fs.writeFileSync(path.join(out, "favicon.svg"), svg({ rounded: true, scale: TILE }).replace(/\n/g, "") + "\n");
const browser = await chromium.launch();
try {
  for (const icon of icons) {
    const page = await browser.newPage({ viewport: { width: icon.size, height: icon.size } });
    await page.setContent(`<style>html,body{margin:0;background:transparent}svg{display:block;width:100vw;height:100vh}</style>${svg(icon)}`);
    await page.screenshot({ path: path.join(out, icon.file), omitBackground: icon.rounded });
    await page.close();
    console.log(`${icon.file} ${icon.size}×${icon.size}`);
  }
} finally {
  await browser.close();
}
