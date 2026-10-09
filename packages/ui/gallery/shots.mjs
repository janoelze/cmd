// Screenshots of the gallery: every page in a few themes (or the ones given),
// into .cmd-dev/shots/ui at the repo root. Starts the gallery's dev server
// itself. `pnpm --filter @cmd/ui shots [theme…]`, e.g. `shots dark light nord`.

import { createServer } from "vite";
import { chromium } from "playwright";
import { mkdirSync } from "node:fs";
import path from "node:path";

const here = import.meta.dirname;
const out = path.resolve(here, "../../../.cmd-dev/shots/ui");
mkdirSync(out, { recursive: true });
const themes = process.argv.slice(2).length ? process.argv.slice(2) : ["dark", "light", "solarized-light", "dracula"];
const pages = ["tokens", "themes", "windows", "buttons", "choices", "fields", "status", "forms", "content", "overlays", "patterns"];

const server = await createServer({ configFile: path.join(here, "vite.config.ts"), server: { port: 0 }, logLevel: "error" });
await server.listen();
const url = server.resolvedUrls.local[0];
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: 1180, height: 900 }, deviceScaleFactor: 2 });
const errors = [];
page.on("pageerror", (e) => errors.push(String(e)));
page.on("console", (m) => m.type() === "error" && errors.push(m.text()));
for (const theme of themes) {
  for (const p of pages) {
    await page.goto(`${url}?theme=${theme}&page=${p}`);
    await page.waitForSelector(".g-page h1");
    await page.waitForTimeout(150);
    const file = path.join(out, `${theme}-${p}.png`);
    await page.locator(".g-scroll").evaluate((el) => {
      // Full page: let the scroller grow to its content.
      el.style.overflow = "visible";
      el.closest(".g").style.height = "auto";
      document.body.style.overflow = "visible";
    });
    await page.screenshot({ path: file, fullPage: true });
  }
}
await browser.close();
await server.close();
console.log(`${themes.length * pages.length} shots in ${out}`);
if (errors.length) {
  console.error(errors.join("\n"));
  process.exit(1);
}
