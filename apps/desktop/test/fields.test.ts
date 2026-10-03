import { describe, expect, it } from "vitest";
import type { Agent, AppWindow, Pane } from "@cmd/protocol";
import { fieldsOf, type SidebarRow } from "../src/renderer/src/model.ts";
import { registerWindowView, setWindowTypes } from "../src/renderer/src/windows/registry.ts";

// Window title fields (docs/10-window-titles.md): one meaning per field, for every type.

setWindowTypes([
  { kind: "text", title: "Text", icon: "doc.text" },
  { kind: "browser", title: "Browser", icon: "globe" },
] as never);
registerWindowView({ kind: "text", View: () => null, describe: () => ({ place: "~/src/cmd" }) });
registerWindowView({ kind: "browser", View: () => null, describe: (w) => ({ name: w.title, place: "github.com" }) });

const pane = (p: Partial<Pane> = {}): Pane =>
  ({ id: "p1", title: "", cwd: "/Users/someone/src/cmd", foreground: "zsh", agentId: null, usage: null, ...p }) as Pane;
const row = (r: Partial<SidebarRow>): SidebarRow => ({ key: "k", pane: null, win: null, agent: null, children: [], urgent: null, ...r });
const win = (w: Partial<AppWindow>): AppWindow => ({ id: "w1", kind: "text", title: "README.md", createdAt: 0, updatedAt: 0, state: {}, ...w });

describe("window fields", () => {
  it("shell: process name, cwd as place, type icon, no light or status", () => {
    const f = fieldsOf(row({ pane: pane() }), undefined, 0);
    expect(f).toMatchObject({ name: "zsh", kind: "zsh", place: "~/src/cmd", icon: "terminal" });
    expect(f.light).toBeUndefined();
    expect(f.status).toBeUndefined();
  });

  it("shell: a real terminal title wins over the process name", () => {
    expect(fieldsOf(row({ pane: pane({ title: "✳ build server" }) }), undefined, 0).name).toBe("build server");
  });

  it("agent: name, status light, state as status keyed by state", () => {
    const agent = { name: "fix tests", kind: "claude", state: "needs_input", detail: null, cwd: "/tmp", stateSince: 0, spawn: {} } as unknown as Agent;
    const f = fieldsOf(row({ pane: pane({ foreground: "claude" }), agent }), undefined, 0);
    expect(f).toMatchObject({ name: "fix tests", kind: "claude", light: "needs", status: { text: "Needs input", key: "needs_input" } });
  });

  it("windows: kind is the type, status and dirty come from the live status", () => {
    const f = fieldsOf(row({ win: win({}) }), { label: "Edited", key: "edited", dirty: true }, 0);
    expect(f).toMatchObject({ name: "README.md", kind: "text", place: "~/src/cmd", icon: "doc.text", dirty: true, status: { text: "Edited", key: "edited" } });
  });

  it("a status without a key is keyed by its text", () => {
    expect(fieldsOf(row({ win: win({}) }), { label: "27 words" }, 0).status?.key).toBe("27 words");
  });

  it("never repeats the name as the place", () => {
    const f = fieldsOf(row({ win: win({ kind: "browser", title: "github.com" }) }), undefined, 0);
    expect(f.name).toBe("github.com");
    expect(f.place).toBeUndefined();
  });
});
