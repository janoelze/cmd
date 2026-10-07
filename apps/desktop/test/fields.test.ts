import { describe, expect, it } from "vitest";
import type { Agent, AppWindow, Pane } from "@cmd/protocol";
import { fieldsOf, setCmdNames, type SidebarRow } from "../src/renderer/src/model.ts";
import { registerWindowView, setWindowTypes } from "../src/renderer/src/windows/registry.ts";

// Window title fields (docs/10-window-titles.md): one meaning per field, for every type.

setWindowTypes([
  { kind: "text", title: "Text", icon: "doc.text" },
  { kind: "browser", title: "Browser", icon: "globe" },
  { kind: "magic", title: "Magic Widget", icon: "sparkles" },
] as never);
registerWindowView({ kind: "text", View: () => null, describe: () => ({ place: "~/src/cmd" }) });
registerWindowView({ kind: "browser", View: () => null, describe: (w) => ({ name: w.title, place: "github.com" }) });
registerWindowView({ kind: "magic", View: () => null, describe: (w) => ({ icon: typeof w.state.icon === "string" ? w.state.icon : undefined }) });

const pane = (p: Partial<Pane> = {}): Pane =>
  ({ id: "p1", title: "", cwd: "/Users/someone/src/cmd", foreground: "zsh", agentId: null, usage: null, attention: null, muted: false, sizedBy: null, ...p }) as Pane;
const row = (r: Partial<SidebarRow>): SidebarRow => ({ key: "k", pane: null, win: null, agent: null, children: [], urgent: null, ...r });
const win = (w: Partial<AppWindow>): AppWindow => ({ id: "w1", kind: "text", title: "README.md", createdAt: 0, updatedAt: 0, state: {}, ...w });

describe("window fields", () => {
  it("shell: process name, cwd as place, type icon, no light or status", () => {
    const f = fieldsOf(row({ pane: pane() }), undefined, 0);
    expect(f).toMatchObject({ name: "zsh", place: "~/src/cmd", icon: "terminal" });
    expect(f.kind).toBeUndefined(); // same as the name
    expect(f.light).toBeUndefined();
    expect(f.status).toBeUndefined();
  });

  it("shell: a real terminal title wins over the process name, which becomes the kind", () => {
    expect(fieldsOf(row({ pane: pane({ title: "✳ build server" }) }), undefined, 0)).toMatchObject({ name: "build server", kind: "zsh" });
  });

  it("shell: a Windows console title that's just the shell's path counts as no title", () => {
    const pwsh = (title: string) => fieldsOf(row({ pane: pane({ title, foreground: "pwsh", cwd: "C:\\Users\\me" }) }), undefined, 0);
    expect(pwsh("Administrator: C:\\Program Files\\PowerShell\\7\\pwsh.exe").name).toBe("pwsh");
    expect(pwsh("C:\\WINDOWS\\system32\\cmd.exe").name).toBe("pwsh");
    expect(pwsh("Windows PowerShell").name).toBe("pwsh");
    expect(pwsh("Administrator: npm run dev").name).toBe("npm run dev");
  });

  it("shell with an attention marker: its text as status, a tinted icon until seen", () => {
    const at = 0;
    const bell = fieldsOf(row({ pane: pane({ attention: { kind: "bell", text: "Bell", urgent: true, at } }) }), undefined, 0);
    expect(bell).toMatchObject({ status: { text: "Bell", key: "attention:bell" }, tone: "needs", icon: "terminal" });
    const done = fieldsOf(row({ pane: pane({ attention: { kind: "command", text: "make finished · 42s", urgent: false, at } }) }), undefined, 0);
    expect(done).toMatchObject({ status: { text: "make finished · 42s" }, tone: "unseen" });
  });

  it("widget: the icon its build picked, else the type's; news tints it, never a light", () => {
    expect(fieldsOf(row({ win: win({ kind: "magic", title: "Weather" }) }), undefined, 0).icon).toBe("sparkles");
    const f = fieldsOf(row({ win: win({ kind: "magic", title: "Weather", state: { icon: "cloud.sun", attention: { kind: "notification", text: "Rain soon", urgent: true, at: 0 } } }) }), undefined, 0);
    expect(f).toMatchObject({ icon: "cloud.sun", tone: "needs", status: { text: "Rain soon" } });
    expect(f.light).toBeUndefined();
  });

  it("agent: name, status light, state as status keyed by state", () => {
    const agent = { name: "fix tests", kind: "claude", state: "needs_input", detail: null, cwd: "/tmp", stateSince: 0, spawn: {} } as unknown as Agent;
    const f = fieldsOf(row({ pane: pane({ foreground: "claude" }), agent }), undefined, 0);
    expect(f).toMatchObject({ name: "fix tests", kind: "claude", light: "needs", status: { text: "Needs input", key: "needs_input" } });
  });

  it("agent without a name: its kind while cmd names it, else its terminal title or prompt", () => {
    const agent = { name: null, kind: "claude", state: "working", detail: null, cwd: "/tmp", stateSince: 0, lastPrompt: "read a few files", spawn: {} } as unknown as Agent;
    const r = row({ pane: pane({ foreground: "claude", title: "✳ Read files" }), agent });
    setCmdNames(true);
    expect(fieldsOf(r, undefined, 0)).toMatchObject({ name: "Claude", kind: undefined });
    setCmdNames(false);
    expect(fieldsOf(r, undefined, 0).name).toBe("Read files");
    expect(fieldsOf(row({ pane: pane({ foreground: "claude", title: "" }), agent }), undefined, 0).name).toBe("read a few files");
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
