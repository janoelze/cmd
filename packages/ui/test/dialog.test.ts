// Dialog and Popover focus, in a real browser: the gallery's overlays page in
// Playwright's Chromium (jsdom has no layout, inert or focus order to check).
// A Dialog is modal: Tab stays inside, the page behind is inert, Escape closes
// it from anywhere inside and focus goes back to where it was. Skipped when
// Playwright's Chromium isn't installed (`pnpm exec playwright install chromium`).

import { existsSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chromium, type Browser, type Page } from "playwright";
import { createServer, type ViteDevServer } from "vite";

const here = import.meta.dirname;
const installed = existsSync(chromium.executablePath());

// Said out loud when skipped (CI doesn't install it), so it doesn't pass as green.
if (!installed) {
  process.stderr.write("[skip] dialog.test.ts: Playwright's Chromium isn't installed (pnpm exec playwright install chromium), so Dialog and Popover focus aren't tested\n");
  it.skip("Playwright's Chromium isn't installed, so Dialog and Popover focus aren't tested", () => {});
}

describe.skipIf(!installed)("Dialog and Popover focus (gallery, Chromium)", () => {
  let server: ViteDevServer;
  let browser: Browser;
  let page: Page;

  beforeAll(async () => {
    server = await createServer({ configFile: path.join(here, "../gallery/vite.config.ts"), server: { port: 0 }, logLevel: "error" });
    await server.listen();
    browser = await chromium.launch();
    page = await browser.newPage({ viewport: { width: 1180, height: 900 } });
  }, 60_000);
  afterAll(async () => {
    await browser?.close();
    await server?.close();
  });

  const open = async () => {
    await page.goto(`${server.resolvedUrls!.local[0]}?theme=dark&page=overlays`);
    await page.waitForSelector(".g-page h1");
  };
  /** Where focus is: inside the open dialog, or what it is outside. */
  const focus = () => page.evaluate(() => {
    const at = document.activeElement;
    const dialog = document.querySelector(".ui-scrim:not([data-closing]) .ui-dialog");
    return { inside: !!dialog && (dialog === at || dialog.contains(at)), what: at ? `${at.tagName.toLowerCase()} ${at.textContent?.trim().slice(0, 30) ?? ""}` : "none" };
  });
  const closed = () => page.waitForSelector(".ui-scrim", { state: "detached" });

  it("keeps Tab and Shift-Tab inside the dialog, and the page behind is inert", async () => {
    await open();
    await page.getByRole("button", { name: "Delete Workspace…" }).click();
    await page.waitForSelector(".ui-dialog");
    expect((await focus()).inside).toBe(true);
    expect(await page.locator("#root").getAttribute("inert")).not.toBeNull();
    for (const key of ["Tab", "Shift+Tab"])
      for (let i = 0; i < 10; i++) {
        await page.keyboard.press(key);
        const f = await focus();
        expect(f.inside, `${key} ×${i + 1} focused ${f.what}`).toBe(true);
      }
    // The page behind takes no clicks either: they land on the scrim and close it.
    await page.keyboard.press("Escape");
    await closed();
    expect(await page.locator("#root").getAttribute("inert")).toBeNull();
  });

  it("closes on Escape wherever focus is inside, and gives focus back to the opener", async () => {
    await open();
    const opener = page.getByRole("button", { name: "Send Feedback…" });
    for (const target of ["Cancel", "textarea", "Close"]) {
      await opener.focus();
      await page.keyboard.press("Enter");
      await page.waitForSelector(".ui-dialog");
      const dialog = page.getByRole("dialog", { name: "Send Feedback" });
      await (target === "textarea" ? dialog.locator("textarea") : dialog.getByRole("button", { name: target, exact: true })).focus();
      expect((await focus()).inside).toBe(true);
      await page.keyboard.press("Escape");
      await closed();
      expect(await opener.evaluate((el) => el === document.activeElement), `Escape from ${target}`).toBe(true);
    }
  });

  it("fades out on close (no pop): the sheet stays, inert, while its opacity falls over several frames", async () => {
    await open();
    await page.getByRole("button", { name: "Send Feedback…" }).click();
    await page.waitForSelector(".ui-dialog");
    await page.waitForTimeout(400);
    const frames = await page.evaluate(async () => {
      document.activeElement?.dispatchEvent(new KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      const seen: number[] = [];
      for (let i = 0; i < 30; i++) {
        await new Promise(requestAnimationFrame);
        const sheet = document.querySelector<HTMLElement>(".ui-scrim[data-closing][inert] .ui-dialog");
        seen.push(sheet ? Number(getComputedStyle(sheet).opacity) * Number(getComputedStyle(sheet.parentElement!).opacity) : 0);
      }
      return seen;
    });
    expect(frames[0]).toBeGreaterThan(0.5);
    expect(frames.filter((o) => o > 0.05 && o < 0.95).length).toBeGreaterThanOrEqual(3);
    await closed();
  });

  it("keeps the page inert when a dialog opens while another is still fading out", async () => {
    await open();
    await page.getByRole("button", { name: "Delete Workspace…" }).click();
    await page.waitForSelector(".ui-dialog");
    await page.keyboard.press("Escape");
    // At once, while the first sheet plays its exit.
    await page.getByRole("button", { name: "Send Feedback…" }).click();
    expect(await page.locator(".ui-scrim[data-closing]").count()).toBe(1);
    await page.waitForSelector(".ui-scrim[data-closing]", { state: "detached" });
    expect(await page.locator("#root").getAttribute("inert")).not.toBeNull();
    await page.keyboard.press("Escape");
    await closed();
    expect(await page.locator("#root").getAttribute("inert")).toBeNull();
  });

  it("keeps a Select inside the dialog reachable by Tab and working", async () => {
    await open();
    await page.getByRole("button", { name: "Send Feedback…" }).click();
    await page.waitForSelector(".ui-dialog");
    const select = page.getByRole("dialog").getByRole("combobox", { name: "Area" });
    let reached = false;
    for (let i = 0; i < 10 && !reached; i++) (await page.keyboard.press("Tab"), (reached = await select.evaluate((el) => el === document.activeElement)));
    expect(reached).toBe(true);
    await select.selectOption("agents");
    expect(await select.inputValue()).toBe("agents");
    await page.keyboard.press("Escape");
    await closed();
  });

  it("lists nothing outside the dialog in the accessibility tree while it is open", async () => {
    await open();
    await page.getByRole("button", { name: "Delete Workspace…" }).click();
    await page.waitForSelector(".ui-dialog");
    // Chromium's own tree (what VoiceOver reads), as e2e/a11y-audit.mjs reads it: inert nodes are ignored.
    const cdp = await page.context().newCDPSession(page);
    const { nodes } = (await cdp.send("Accessibility.getFullAXTree")) as { nodes: { ignored: boolean; role?: { value: string }; name?: { value: string } }[] };
    await cdp.detach();
    const controls = nodes.filter((n) => !n.ignored && ["button", "combobox", "textbox", "checkbox", "link", "tab", "radio", "switch"].includes(n.role?.value ?? "")).map((n) => `${n.role!.value} ${n.name?.value}`);
    expect(controls).toEqual(["button Close", "button Cancel", "button Delete"]);
    await page.keyboard.press("Escape");
    await closed();
  });

  it("shows a tooltip on a dialog's button above the dialog", async () => {
    await open();
    await page.getByRole("button", { name: "Send Feedback…" }).click();
    await page.waitForSelector(".ui-dialog");
    const close = page.getByRole("dialog").getByRole("button", { name: "Close" });
    await close.hover();
    const tip = page.locator(".tip-layer .tip", { hasText: "Close" });
    await tip.waitFor({ state: "visible" });
    const box = (await tip.boundingBox())!;
    // The tip takes no pointer; let it, for a moment, to see what is on top there.
    const top = await page.evaluate(([x, y]) => {
      const layer = document.querySelector<HTMLElement>(".tip-pos")!;
      layer.style.pointerEvents = "auto";
      const hit = !!document.elementFromPoint(x, y)?.closest(".tip-layer");
      layer.style.pointerEvents = "";
      return hit;
    }, [box.x + box.width / 2, box.y + box.height / 2]);
    expect(top).toBe(true);
    await page.keyboard.press("Escape");
    await closed();
  });

  it("moves focus into a dialog Popover on open and back to its anchor on Escape", async () => {
    await open();
    const anchor = page.getByRole("button", { name: "Core details" });
    await anchor.click();
    const pop = page.getByRole("dialog");
    await pop.waitFor();
    await expect.poll(() => pop.evaluate((el) => el.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await page.waitForSelector(".ui-popover", { state: "detached" });
    expect(await anchor.evaluate((el) => el === document.activeElement)).toBe(true);
  });
});
