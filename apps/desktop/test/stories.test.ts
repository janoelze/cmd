// @vitest-environment happy-dom
// The widget elements' stories (windows/package/elements.story.tsx, docs/56): there is one
// variant per element of API 1, and every variant renders in every built-in theme with no
// error and no warning (a warning is something the allow-list dropped from a story's tree).
// The kit's own stories render in Chromium (packages/ui/test/stories.test.ts); these need
// the renderer's modules, so they render here. So do the widget packages' stories
// (packages/widgets/*/src/*.story.tsx, drawn through workbench/widgetStory.tsx).
import fs from "node:fs";
import path from "node:path";
import { act, createElement, type ComponentType } from "react";
import { createRoot } from "react-dom/client";
import { afterAll, describe, expect, it, vi } from "vitest";
import { API_ELEMENT_NAMES } from "@cmd/protocol";
import { allThemes, applyTheme } from "@cmd/ui/themes";
import "@cmd/ui/themes/builtin";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const stories = (await import("../src/renderer/src/windows/package/elements.story.tsx")) as Record<string, ComponentType>;

describe("widget element stories", () => {
  const errors: string[] = [];
  const warn = vi.spyOn(console, "warn").mockImplementation((...a) => void errors.push(`warn: ${a.join(" ")}`));
  const error = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(`error: ${a.join(" ")}`));
  afterAll(() => (warn.mockRestore(), error.mockRestore()));

  it("has a variant for every element of API 1", () => {
    expect(API_ELEMENT_NAMES.filter((name) => typeof stories[name] !== "function")).toEqual([]);
  });

  it("renders every variant in every theme without an error", async () => {
    const themes = allThemes();
    expect(themes.length).toBeGreaterThan(2);
    const broken: string[] = [];
    for (const theme of themes) {
      applyTheme(theme);
      for (const [name, Story] of Object.entries(stories)) {
        if (typeof Story !== "function") continue;
        // A thousand rows say nothing new per theme: once is enough (and happy-dom is slow at it).
        if (name === "ThousandRows" && theme !== themes[0]) continue;
        const el = document.createElement("div");
        document.body.append(el);
        const root = createRoot(el, { onCaughtError: (e) => void errors.push(`caught: ${String(e)}`), onUncaughtError: (e) => void errors.push(`uncaught: ${String(e)}`) });
        errors.length = 0;
        await act(async () => root.render(createElement(Story)));
        // The example widget runs in the widget runtime, which answers in microtasks: wait for its rows.
        if (name === "ExampleAgents") await vi.waitFor(() => expect(el.querySelectorAll(".ui-list-row").length).toBeGreaterThan(0));
        if (el.querySelector(".ui-callout[data-tone=danger] .ui-callout-title")?.textContent === "This widget couldn't be drawn") errors.push("the tree couldn't be drawn");
        if (!el.textContent) errors.push("drew nothing");
        if (errors.length) broken.push(`${name} (${theme.id}): ${errors[0]}`);
        await act(async () => root.unmount());
        el.remove();
      }
    }
    expect(broken).toEqual([]);
  }, 60_000);
});

describe("widget package stories", () => {
  const root = path.resolve(import.meta.dirname, "../../../packages/widgets");
  const files = fs.readdirSync(root).flatMap((p) => (fs.existsSync(path.join(root, p, "src")) ? fs.readdirSync(path.join(root, p, "src")).filter((f) => f.endsWith(".story.tsx")).map((f) => path.join(root, p, "src", f)) : []));

  it("has the built-in packages' stories", () => {
    expect(files.map((f) => path.relative(root, f))).toContain(path.join("agents", "src", "activity.story.tsx"));
  });

  it("renders every variant in every theme without an error", async () => {
    const { widgetStory } = await import("../src/renderer/src/workbench/widgetStory.tsx");
    const errors: string[] = [];
    const warn = vi.spyOn(console, "warn").mockImplementation((...a) => void errors.push(`warn: ${a.join(" ")}`));
    const error = vi.spyOn(console, "error").mockImplementation((...a) => void errors.push(`error: ${a.join(" ")}`));
    const broken: string[] = [];
    try {
      for (const file of files) {
        const pkg = JSON.parse(fs.readFileSync(path.join(path.dirname(path.dirname(file)), "package.json"), "utf8"));
        const variants = widgetStory(await import(file), pkg, path.basename(file, ".story.tsx"));
        expect(Object.keys(variants).length).toBeGreaterThan(0);
        for (const theme of allThemes()) {
          applyTheme(theme);
          for (const [name, Story] of Object.entries(variants)) {
            const el = document.createElement("div");
            document.body.append(el);
            const root = createRoot(el, { onCaughtError: (e) => void errors.push(`caught: ${String(e)}`), onUncaughtError: (e) => void errors.push(`uncaught: ${String(e)}`) });
            errors.length = 0;
            await act(async () => root.render(createElement(Story)));
            // The widget runs, then its tree is drawn (inside act: the still arrives after the first render): a row or the empty state.
            await act(async () => void (await vi.waitFor(() => expect(el.querySelector(".ui-list-row, .ui-viewstate-title"), `${name} (${theme.id}) drew no rows`).not.toBeNull())));
            if (errors.length) broken.push(`${path.basename(file)} ${name} (${theme.id}): ${errors[0]}`);
            await act(async () => root.unmount());
            el.remove();
          }
        }
      }
    } finally {
      warn.mockRestore();
      error.mockRestore();
    }
    expect(broken).toEqual([]);
  }, 60_000);
});
