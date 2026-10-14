// @vitest-environment happy-dom
// The widget elements' stories (windows/package/elements.story.tsx, docs/56): there is one
// variant per element of API 1, and every variant renders in every built-in theme with no
// error and no warning (a warning is something the allow-list dropped from a story's tree).
// The kit's own stories render in Chromium (packages/ui/test/stories.test.ts); these need
// the renderer's modules, so they render here.
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
