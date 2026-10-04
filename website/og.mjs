// Renders the website's Open Graph image and icons from the app icon:
// public/assets/og.png (1200×630, the icon centred on black), icon-180.png and
// icon-64.png. Run from the repo root after the icon changes: node website/og.mjs

import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium } from "playwright";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const icon = "data:image/png;base64," + readFileSync(join(root, "apps/desktop/build/icon.png")).toString("base64");
const out = (f) => join(root, "website/public/assets", f);

const browser = await chromium.launch();
const shot = async (w, h, size, bg, file) => {
  const page = await browser.newPage({ viewport: { width: w, height: h } });
  await page.setContent(`<body style="margin:0;height:100vh;display:grid;place-items:center;background:${bg}"><img src="${icon}" style="width:${size}px;height:${size}px">`);
  await page.screenshot({ path: out(file), omitBackground: bg === "transparent" });
  await page.close();
};
await shot(1200, 630, 440, "#000", "og.png");
await shot(180, 180, 180, "transparent", "icon-180.png");
await shot(64, 64, 64, "transparent", "icon-64.png");
await browser.close();
