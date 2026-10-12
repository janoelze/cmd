// Where pageScrollbars floats a thumb, in a real browser (jsdom has no layout): at the
// scroller's right edge, as tall as it is on screen, also inside a scaled ancestor (the
// canvas view zooms its windows with a transform) and after that ancestor moves (panning).
// Needs Playwright's Chromium (`pnpm exec playwright install chromium`; CI installs it).

import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { needs } from "../../../test/system.ts";
import { scrollbarScript } from "../src/scrollbars.ts";

const noChromium = needs(existsSync(chromium.executablePath()), "Playwright's Chromium (pnpm exec playwright install chromium)");
if (noChromium) it.skip("Playwright's Chromium isn't installed, so where scrollbars float isn't tested", () => {});

describe.skipIf(noChromium)("pageScrollbars placement (Chromium)", () => {
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    browser = await chromium.launch();
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
  });

  /** A 300×200 scroller (4px border) in a track transformed by `transform`, thumbs always shown. */
  const load = async (transform: string) => {
    // A fresh page each time: the script runs once per window.
    await page?.close();
    page = await browser.newPage({ viewport: { width: 1000, height: 800 } });
    await page.setContent(`
      <style>body { margin: 0 } #s { overflow: auto; width: 300px; height: 200px; border: 4px solid #888 } #s div { height: 2000px }</style>
      <div id="track" style="transform-origin: 0 0; transform: ${transform}"><div style="padding: 50px"><div id="s"><div></div></div></div></div>`);
    await page.evaluate((script) => {
      // The thumbs live in a closed shadow root: open it to read them.
      const attach = Element.prototype.attachShadow;
      Element.prototype.attachShadow = function (o) {
        return attach.call(this, { ...o, mode: "open" });
      };
      new Function(script)();
    }, scrollbarScript({ always: true }));
  };
  /** The scroller's padding box on screen, and the vertical bar's box. */
  const measure = () =>
    page.evaluate(async () => {
      await new Promise(requestAnimationFrame);
      const s = document.querySelector("#s")!;
      const r = s.getBoundingClientRect();
      const k = r.width / (s as HTMLElement).offsetWidth;
      const bar = document.querySelector("cmd-scrollbars")!.shadowRoot!.querySelector(".bar.y.on")!.getBoundingClientRect();
      return {
        box: { right: r.right - s.clientLeft * k, top: r.top + s.clientTop * k, height: s.clientHeight * k },
        bar: { right: bar.right, top: bar.top, height: bar.height },
      };
    });
  const scroll = () => page.evaluate(() => document.querySelector("#s")!.scrollBy(0, 100));

  for (const [name, transform] of [
    ["unscaled", "none"],
    ["zoomed out (canvas at 50%)", "translate(30px, 20px) scale(0.5)"],
    ["zoomed in (canvas at 150%)", "translate(-10px, -10px) scale(1.5)"],
  ]) {
    it(`sits on the scroller's right edge, as tall as it: ${name}`, async () => {
      await load(transform);
      await scroll();
      const { box, bar } = await measure();
      expect(bar.right).toBeCloseTo(box.right, 0);
      expect(bar.top).toBeCloseTo(box.top, 0);
      expect(bar.height).toBeCloseTo(box.height, 0);
    });
  }

  it("follows when the scaled track moves without scrolling (panning the canvas)", async () => {
    await load("translate(0px, 0px) scale(0.5)");
    await scroll();
    await page.evaluate(() => {
      document.querySelector<HTMLElement>("#track")!.style.transform = "translate(120px, 80px) scale(0.5)";
      document.dispatchEvent(new Event("cmd-scrollbars-moved"));
    });
    const { box, bar } = await measure();
    expect(bar.right).toBeCloseTo(box.right, 0);
    expect(bar.top).toBeCloseTo(box.top, 0);
  });
});
