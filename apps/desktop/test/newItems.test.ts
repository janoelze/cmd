// New… (⌘N): windows first, then your widgets by last use, then the built-in
// ones; typed text opens a URL or path, or makes a widget with Magic.

import { describe, expect, it, vi } from "vitest";
import type { WidgetEntry } from "@cmd/protocol";

vi.mock("../src/renderer/src/actions.ts", () => ({ openPath: vi.fn() }));
const { magicItem, newItems, openableTarget, openItems } = await import("../src/renderer/src/newItems.ts");
const { platformDefaults } = await import("../src/shared/commands.ts");

const MAC = platformDefaults(true);
const entry = (ref: string, source: "yours" | "builtin", usedAt?: number): WidgetEntry =>
  ({ ref, source, kind: source === "yours" ? "magic" : ref.slice(5), title: ref, icon: "sparkles", windows: [], usedAt }) as WidgetEntry;

describe("New… items", () => {
  const library = [entry("type:timer", "builtin"), entry("magic:a", "yours", 1), entry("type:diff", "builtin"), entry("magic:b", "yours", 2)];
  const items = newItems(library, MAC, () => {}, () => {});

  it("lists windows, then your widgets by last use, then built-in ones", () => {
    expect(items.map((i) => i.id)).toEqual([
      "file.newTerminal", "file.newClaude", "file.newCodex", "file.newBrowser", "file.newFiles", "file.newText",
      "magic:b", "magic:a", "type:timer", "type:diff",
    ]);
    expect(items[0]).toMatchObject({ group: "Windows", label: "Terminal", hint: "⌘T" });
  });

  it("runs a window's own command and adds a widget by its ref", () => {
    const run = vi.fn();
    const add = vi.fn();
    const xs = newItems(library, MAC, run, add);
    xs[3]!.run();
    xs.at(-1)!.run();
    expect(run).toHaveBeenCalledWith("file.newBrowser");
    expect(add).toHaveBeenCalledWith("type:diff");
  });

  it("opens typed URLs and paths, and makes a widget of anything else", () => {
    expect(openItems("example.com", "Open")[0]).toMatchObject({ label: "Open example.com", hint: "url" });
    expect(openItems("~/src", "Open")[0]).toMatchObject({ hint: "path" });
    expect(openItems("my open MRs", "Open")).toEqual([]);
    expect(magicItem("", MAC, () => {})[0]).toMatchObject({ label: "New Widget with Magic", hint: "⇧⌘M" });
    const make = vi.fn();
    const [m] = magicItem("my open MRs", MAC, make);
    expect(m!.label).toBe("Make “my open MRs” with Magic");
    m!.run();
    expect(make).toHaveBeenCalledWith("my open MRs");
    expect(magicItem("https://example.com", MAC, () => {})).toEqual([]);
    expect(openableTarget("localhost:3000")).toEqual({ kind: "url", value: "localhost:3000" });
  });
});
