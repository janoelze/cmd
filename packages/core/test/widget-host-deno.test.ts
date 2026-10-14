// A package widget in real Deno (docs/56, phase 1 "The process"): a fixture package on
// @cmd/widget-api, granted, opened in a window of a core listening on its sockets. Its process
// connects to the widgets socket, says hello, renders; its subscription to agents gets the
// current value and then the change when an agent starts (a patch reaches the window); a
// press on its Button reaches its handler, whose cmd.windows.select the core carries out; the
// process stops after its window closes. Under sandbox-exec where this Mac can apply it.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { connect, type Connection } from "@cmd/protocol/node";
import type { CoreEvent, TreeNode } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { findDeno } from "../src/widgets/deno.ts";
import { sandboxAvailable } from "../src/lib/sandbox.ts";
import { fakeFactory } from "./fake-pty.ts";
import { needs, SYSTEM_TIMEOUT, until } from "../../../test/system.ts";

const DENO = findDeno();
const noDeno = needs(DENO, "Deno (on PATH, or ~/.deno/bin; `brew install deno`)");
const GH = (() => {
  try {
    return execFileSync("/bin/sh", ["-lc", "command -v gh"], { encoding: "utf8" }).trim();
  } catch {
    return "";
  }
})();

const MAIN = `import { View, Text, Button, useAgents, cmd } from "@cmd/widget-api";

export default function Live() {
  const agents = useAgents();
  return (
    <View>
      <Text>{\`\${agents.length} agents\`}</Text>
      <Button onClick={() => void cmd.windows.select(agents[0]?.windowId ?? "none")}>Go</Button>
    </View>
  );
}
`;

const RUNS = `import { useEffect, useState } from "react";
import { View, Text, Button, cmd } from "@cmd/widget-api";

export default function Runs() {
  const [lines, setLines] = useState<string[]>([]);
  const say = (l: string) => setLines((x) => [...x, l]);
  useEffect(() => {
    cmd.run("gh", ["run", "list", "-L", "1", "-R", "cli/cli"]).then((r) => say(\`gh exited \${r.code}\`), (e) => say(\`gh refused: \${e.message}\`));
    cmd.run("docker", ["run", "-v", "/:/h", "alpine"]).then(() => say("docker ran"), (e) => say(\`docker refused: \${e.message}\`));
  }, []);
  return (
    <View>
      {lines.map((l) => <Text key={l}>{l}</Text>)}
      <Button onClick={() => void cmd.terminals.open({ command: "gh run rerun 1" }).then((r) => say(\`opened \${typeof r.id}\`), (e) => say(\`not opened: \${e.message}\`))}>Rerun</Button>
    </View>
  );
}
`;

const texts = (nodes: TreeNode[]): string[] => nodes.flatMap((n) => (n.type === "#text" ? [n.text] : texts(n.children)));
const find = (nodes: TreeNode[], type: string): Extract<TreeNode, { props: unknown }> | null => {
  for (const n of nodes) {
    if (n.type === "#text") continue;
    if (n.type === type) return n;
    const hit = find(n.children, type);
    if (hit) return hit;
  }
  return null;
};

const cleanup: (() => unknown)[] = [];
afterAll(async () => {
  for (const fn of cleanup.reverse()) await fn();
});

describe.skipIf(noDeno)("a package widget in Deno", () => {
  it(
    "starts, says hello, gets agents live, takes a press, and stops after its window closes",
    async () => {
      // Short: the widgets socket path must fit macOS's 104 bytes.
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwd-")));
      cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const home = path.join(dir, "widgets");
      const pkg = path.join(home, "live");
      fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "live", version: "1.0.0", cmd: { api: 1, widgets: [{ id: "main", title: "Live", main: "src/main.tsx" }], permissions: { workspace: ["read"] } } }));
      fs.writeFileSync(path.join(pkg, "src", "main.tsx"), MAIN);

      process.env.CMD_WIDGETS_HOME = home;
      const unsandboxed = process.env.CMD_MAGIC_UNSANDBOXED;
      if (!sandboxAvailable()) process.env.CMD_MAGIC_UNSANDBOXED = "1"; // inside another sandbox (Agent Safehouse): Deno's permissions alone
      cleanup.push(() => (unsandboxed === undefined ? delete process.env.CMD_MAGIC_UNSANDBOXED : (process.env.CMD_MAGIC_UNSANDBOXED = unsandboxed)));
      const socketPath = path.join(dir, "core.sock");
      const core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: path.join(dir, "state") });
      delete process.env.CMD_WIDGETS_HOME;
      cleanup.push(() => core.close());
      core.library.host.configure({ times: { stopAfterMs: 300 } });
      await core.listen();
      await core.scheduler.idle();

      const conn: Connection = await connect(socketPath);
      cleanup.push(() => conn.close());
      const events: CoreEvent[] = [];
      conn.client.onEvent((e) => void events.push(e));
      await conn.client.call("events.subscribe", { types: ["widget.tree", "window.focus"] });
      await conn.client.call("widget.grant", { name: "live" });

      const ws = core.workspaces.home();
      const first = core.panes.create({ workspaceId: ws.id });
      core.agents.ingestHook(first.id, "claude", "UserPromptSubmit", { session_id: "one", prompt: "first" });
      const w = await conn.client.call("widget.add", { ref: "pkg:live/main", workspaceId: ws.id });

      const mine = () => events.filter((e): e is Extract<CoreEvent, { type: "widget.tree" }> => e.type === "widget.tree" && e.windowId === w.id).map((e) => e.message);
      await until("the widget's status: running", () => mine().some((m) => m.kind === "status" && m.state === "running"), 3 * SYSTEM_TIMEOUT - 10_000);
      // The first tree may still say 0 (before its subscription answered); the window's tree soon says 1.
      const shows = async (n: number) => {
        await until(`"${n} agents" in the window's tree`, async () => {
          await conn.client.call("widget.resync", { windowId: w.id });
          const t = mine().filter((m) => m.kind === "tree").at(-1);
          return t?.kind === "tree" && texts(t.nodes).includes(`${n} agents`);
        });
      };
      await shows(1);

      // A change is pushed: a second agent, a patch, no call from the widget.
      const patches = mine().filter((m) => m.kind === "patch").length;
      const second = core.panes.create({ workspaceId: ws.id });
      core.agents.ingestHook(second.id, "claude", "UserPromptSubmit", { session_id: "two", prompt: "second" });
      await until("a patch after the agent started", () => mine().filter((m) => m.kind === "patch").length > patches);
      await shows(2);

      // A press reaches the Button's handler, which selects the first agent's window.
      const tree = mine().filter((m) => m.kind === "tree").at(-1)!;
      const button = find(tree.kind === "tree" ? tree.nodes : [], "Button")!;
      const handler = (button.props.onClick as { $handler: number }).$handler;
      events.length = 0;
      await conn.client.call("widget.interact", { windowId: w.id, handler, event: "onClick" });
      await until("window.focus from the widget's cmd.windows.select", () => events.some((e) => e.type === "window.focus"));
      expect(events.find((e) => e.type === "window.focus")).toMatchObject({ id: expect.stringMatching(new RegExp(`^(${first.id}|${second.id})$`)) });

      // The window closes: its process stops after the delay.
      expect(core.library.host.running()).toBe(1);
      core.windows.close(w.id);
      await until("the process stopped", () => core.library.host.running() === 0);
    },
    3 * SYSTEM_TIMEOUT,
  );

  // API 1.1 in a real process: cmd.run("gh", ["run", "list"]) runs gh through the core (Deno itself
  // may run nothing: no --allow-run), docker run is refused with the policy's reason, and a press
  // on a Button whose handler opens a terminal asks the person (tool.acting) before anything opens.
  it.skipIf(!GH)(
    "runs gh run list through the core with no allow-run, and an act asks before it runs",
    async () => {
      const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cwr-")));
      cleanup.push(() => fs.rmSync(dir, { recursive: true, force: true }));
      const home = path.join(dir, "widgets");
      const pkg = path.join(home, "ci");
      fs.mkdirSync(path.join(pkg, "src"), { recursive: true });
      fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "ci", version: "1.1.0", cmd: { api: 1, widgets: [{ id: "main", title: "CI", main: "src/main.tsx" }], permissions: { run: ["gh", "docker"], act: ["terminals.open"], workspace: ["read"] } } }));
      fs.writeFileSync(path.join(pkg, "src", "main.tsx"), RUNS);

      process.env.CMD_WIDGETS_HOME = home;
      const unsandboxed = process.env.CMD_MAGIC_UNSANDBOXED;
      if (!sandboxAvailable()) process.env.CMD_MAGIC_UNSANDBOXED = "1";
      cleanup.push(() => (unsandboxed === undefined ? delete process.env.CMD_MAGIC_UNSANDBOXED : (process.env.CMD_MAGIC_UNSANDBOXED = unsandboxed)));
      const socketPath = path.join(dir, "core.sock");
      const core = new Core({ socketPath, dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: path.join(dir, "state") });
      delete process.env.CMD_WIDGETS_HOME;
      cleanup.push(() => core.close());
      await core.listen();
      await core.scheduler.idle();
      const conn: Connection = await connect(socketPath);
      cleanup.push(() => conn.close());
      const events: CoreEvent[] = [];
      conn.client.onEvent((e) => void events.push(e));
      await conn.client.call("events.subscribe", { types: ["widget.tree", "tool.acting"] });
      await conn.client.call("widget.grant", { name: "ci" });
      const ws = core.workspaces.open(process.cwd()).workspace;
      const w = await conn.client.call("widget.add", { ref: "pkg:ci/main", workspaceId: ws.id });
      const mine = () => events.filter((e): e is Extract<CoreEvent, { type: "widget.tree" }> => e.type === "widget.tree" && e.windowId === w.id).map((e) => e.message);
      const says = async (what: RegExp) => {
        let last = "";
        await until(`the window to say ${what}`, async () => {
          await conn.client.call("widget.resync", { windowId: w.id });
          const t = mine().filter((m) => m.kind === "tree").at(-1);
          last = t?.kind === "tree" ? texts(t.nodes).join(" | ") : "";
          return what.test(last);
        });
        return last;
      };
      // gh ran (an exit code, whatever the network said); docker run was refused, with why.
      const shown = await says(/gh exited \d+/);
      expect(shown).toMatch(/docker refused: .*docker only read-only docker commands/);

      // The Button's handler opens a terminal with a command typed: it waits for the person.
      const tree = mine().filter((m) => m.kind === "tree").at(-1)!;
      const handler = (find(tree.kind === "tree" ? tree.nodes : [], "Button")!.props.onClick as { $handler: number }).$handler;
      await conn.client.call("widget.interact", { windowId: w.id, handler, event: "onClick" });
      await until("the ask", () => events.some((e) => e.type === "tool.acting" && e.call.state === "waiting"));
      const ask = events.find((e): e is Extract<CoreEvent, { type: "tool.acting" }> => e.type === "tool.acting" && e.call.state === "waiting")!.call;
      expect(ask).toMatchObject({ caller: "CI", callerKind: "widget", tool: "terminals.open", approval: { permission: "show", exact: "gh run rerun 1", widget: { name: "ci", version: "1.1.0" } } });
      expect(core.panes.list().filter((p) => p.workspaceId === ws.id)).toHaveLength(0);
      await conn.client.call("approvals.answer", { workspaceId: ws.id, itemId: ask.id, allow: true });
      await says(/opened string/);
      expect(core.panes.list().filter((p) => p.workspaceId === ws.id)).toHaveLength(1);
    },
    3 * SYSTEM_TIMEOUT,
  );
});
