// @vitest-environment happy-dom
// The renderer's commands (shell/commands/registry.ts): every command in the list has one
// implementation, the palette leaves out what doesn't apply, and context menus don't repeat
// a command under its label (they name the command instead).
import fs from "node:fs";
import path from "node:path";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { COMMANDS, DEFAULT_KEYBINDINGS } from "../src/shared/commands.ts";

// The renderer's modules talk to main and the core through lib/bridge.ts from their first line: nothing answers here.
// What the build defines (electron.vite.config.ts).
vi.stubGlobal("__APP_VERSION__", "0.0.0");
vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));

let registry: typeof import("../src/renderer/src/shell/commands/registry.ts");
let palette: typeof import("../src/renderer/src/shell/palette.ts");
beforeAll(async () => {
  await import("../src/renderer/src/shell/commands/index.ts");
  for (const k of ["files", "magic", "actions", "text", "operator", "inspector"]) await import(`../src/renderer/src/windows/${k}/commands.ts`);
  registry = await import("../src/renderer/src/shell/commands/registry.ts");
  palette = await import("../src/renderer/src/shell/palette.ts");
});

/** A context with a terminal selected; `agent` adds one in it, with a session. */
function context(agent: boolean) {
  const a = agent ? ({ id: "a1", kind: "claude", native: { claudeSessionId: "s1" }, cwd: "/w" } as never) : null;
  return {
    state: { workspaceId: "w", workspaces: new Map(), agents: new Map(), panes: new Map(), windows: new Map(), closed: [] },
    board: { mode: "grid", layoutMode: "grid", docks: { left: {}, right: {} }, windows: [], order: [], allFlat: [], stripWidths: {} },
    workspace: { id: "w", root: "/w", home: false },
    workspaces: [{ id: "w" }],
    selected: "p1",
    pane: { id: "p1", cwd: "/w" },
    window: undefined,
    agent: a,
    session: agent ? "s1" : null,
    aiReady: true,
    actions: undefined,
    side: null,
    folder: "/w",
    editing: false,
    attention: 0,
    canReopen: false,
  } as unknown as import("../src/renderer/src/shell/commands/registry.ts").CommandContext;
}

describe("commands in the renderer", () => {
  it("implements every command once", () => {
    expect([...registry.registeredCommands()].sort()).toEqual(COMMANDS.map((c) => c.id).sort());
  });

  it("leaves the agent's commands out of the palette when no agent is selected", () => {
    const ids = (agent: boolean) => palette.commandItems(context(agent), DEFAULT_KEYBINDINGS).map((i) => i.id);
    for (const id of ["session.copyId", "session.summarize", "session.rename"]) {
      expect(ids(false)).not.toContain(id);
      expect(ids(true)).toContain(id);
    }
  });

  it("names commands in context menus instead of repeating their labels", () => {
    const labels = new Set(COMMANDS.map((c) => c.label as string));
    const root = path.join(import.meta.dirname, "../src/renderer/src");
    const repeated: string[] = [];
    for (const f of fs.readdirSync(root, { recursive: true }) as string[]) {
      if (!/\.tsx?$/.test(f)) continue;
      const src = fs.readFileSync(path.join(root, f), "utf8");
      if (!src.includes("showContextMenu") && !src.includes("MenuEntry")) continue;
      // Labels given to commandItem are a command's own, shorter for its menu.
      for (const m of src.replace(/commandItem\([^)]*\)/g, "").matchAll(/label: "([^"]+)"/g)) if (labels.has(m[1]!)) repeated.push(`${f}: ${m[1]}`);
    }
    expect(repeated).toEqual([]);
  });
});
