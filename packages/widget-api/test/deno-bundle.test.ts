// The vendored bundle (scripts/widget-api-bundle.mjs) under the widget process's own
// flags: Deno with --no-remote --no-npm loads a TSX widget importing react and
// @cmd/widget-api through the import map alone, runs it through the runtime, and the
// wire messages come out: hello, the tree, a patch once its subscription answers.

import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { needs, SYSTEM_TIMEOUT } from "../../../test/system.ts";

const root = path.join(import.meta.dirname, "../../..");
const DENO = [...(process.env.PATH ?? "").split(":").map((d) => path.join(d, "deno")), "/opt/homebrew/bin/deno", path.join(os.homedir(), ".deno/bin/deno")].find((p) => fs.existsSync(p));
const noDeno = needs(DENO, "Deno (on PATH, or ~/.deno/bin; `brew install deno`)");

const WIDGET = `import { useState } from "react";
import { View, Text, Button, useAgents } from "@cmd/widget-api";
import { run } from "@cmd/widget-api/runtime";

function Agents() {
  const agents = useAgents();
  const [n, setN] = useState(0);
  return <View><Text>{\`\${agents.length} agents\`}</Text><Button onClick={() => setN(n + 1)}>{\`Pressed \${n}\`}</Button></View>;
}

const sent: unknown[] = [];
let listener: (m: unknown) => void = () => {};
const reply = (m: unknown) => queueMicrotask(() => listener(m));
const transport = {
  send(m: { kind: string; id?: number }) {
    sent.push(m);
    if (m.kind === "hello") reply({ kind: "ready", env: { version: "0.0.0", api: { major: 1, minor: 0 }, verbs: [], theme: "dark", size: "regular", placement: "board" }, config: {}, state: {} });
    if (m.kind === "subscribe") reply({ kind: "event", sub: m.id, data: [{ id: "a" }, { id: "b" }] });
  },
  listen(fn: (m: unknown) => void) {
    listener = fn;
    return () => {};
  },
};
await run(transport as never, Agents, { package: "demo", version: "1.0.0", widget: "agents" });
await new Promise((r) => setTimeout(r, 100));
console.log(JSON.stringify(sent));
Deno.exit(0);
`;

describe.skipIf(noDeno)("the Deno bundle", () => {
  it(
    "loads under deno run --no-remote --no-npm through the import map and runs a widget",
    () => {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-widget-api-"));
      const out = path.join(dir, "vendor");
      execFileSync(process.execPath, [path.join(root, "scripts/widget-api-bundle.mjs"), "--out", out], { stdio: "pipe" });
      const app = path.join(dir, "widget");
      fs.mkdirSync(app);
      fs.writeFileSync(path.join(app, "main.tsx"), WIDGET);
      fs.writeFileSync(path.join(app, "deno.json"), JSON.stringify({ compilerOptions: { jsx: "react-jsx", jsxImportSource: "react" } }));
      const stdout = execFileSync(DENO!, ["run", "--no-remote", "--no-npm", "--no-prompt", `--import-map=${path.join(out, "import-map.json")}`, `--config=${path.join(app, "deno.json")}`, path.join(app, "main.tsx")], {
        env: { ...process.env, DENO_DIR: path.join(dir, "deno-dir"), NO_COLOR: "1", DENO_NO_UPDATE_CHECK: "1" },
        encoding: "utf8",
        timeout: SYSTEM_TIMEOUT,
      });
      const sent = JSON.parse(stdout.trim().split("\n").at(-1)!) as { kind: string; [k: string]: unknown }[];
      expect(sent[0]).toEqual({ kind: "hello", api: 1, minor: 1, package: "demo", version: "1.0.0", widget: "agents" });
      expect(sent.map((m) => m.kind)).toEqual(["hello", "tree", "subscribe", "patch"]);
      expect(JSON.stringify(sent[1])).toContain("0 agents");
      expect(sent[3]).toMatchObject({ kind: "patch", rev: 2, ops: [{ op: "text", text: "2 agents" }] });
      fs.rmSync(dir, { recursive: true, force: true });
    },
    3 * SYSTEM_TIMEOUT,
  );
});
