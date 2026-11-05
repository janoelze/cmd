// acceleratorOf: a key event as the shortcut the menu bar would see, on the user's keyboard layout.
import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
const { acceleratorOf } = await import("../src/renderer/src/lib/keybindings.ts");

const key = (code: string, mods: Partial<Record<"altKey" | "metaKey" | "ctrlKey" | "shiftKey", boolean>> = {}) =>
  ({ code, key: "", altKey: false, metaKey: false, ctrlKey: false, shiftKey: false, ...mods }) as KeyboardEvent;
// What a German layout types on the keys where a US one has ] - / y z.
const german = new Map([["BracketRight", "+"], ["Slash", "-"], ["KeyY", "z"], ["KeyZ", "y"], ["Digit6", "6"]]);

describe("acceleratorOf", () => {
  it("names a key by what the layout types on macOS, as the menu bar matches it", () => {
    // ⌥⌘+ on a German layout widens the window; it is not ⌥⌘] (Unfold in a text window).
    expect(acceleratorOf(key("BracketRight", { altKey: true, metaKey: true }), true, german)).toBe("Alt+Cmd+Plus");
    expect(acceleratorOf(key("Slash", { altKey: true, metaKey: true }), true, german)).toBe("Alt+Cmd+-");
    expect(acceleratorOf(key("KeyY", { metaKey: true }), true, german)).toBe("Cmd+Z");
  });

  it("falls back to the key's US position before the layout is known, and for keys it doesn't map", () => {
    expect(acceleratorOf(key("BracketRight", { altKey: true, metaKey: true }), true, null)).toBe("Alt+Cmd+]");
    expect(acceleratorOf(key("ArrowUp", { altKey: true }), true, german)).toBe("Alt+Up");
    expect(acceleratorOf(key("F5"), true, german)).toBe("F5");
  });

  it("keeps US positions outside macOS", () => {
    expect(acceleratorOf(key("BracketRight", { ctrlKey: true }), false, german)).toBe("Ctrl+]");
  });
});
