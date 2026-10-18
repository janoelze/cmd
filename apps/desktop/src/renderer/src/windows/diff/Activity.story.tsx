// Live Diff across worktrees (prototype): five agents in worktrees of one project and
// the main checkout, two of them on the same files; by agent and by area; one agent;
// every size; and this repository for real.

import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { useMemo } from "react";
import { cmd } from "../../lib/bridge.ts";
import { useStoreValue } from "../../lib/store.ts";
import { ActivityView, type Lane } from "./Activity.tsx";
import { lanesOf, useWorktrees } from "./worktrees.ts";

// Real code for the shared files' texts (the renderer's own files stand in for rpc.ts and checkout.ts: it may not read other packages).
import RPC from "../../lib/model.ts?raw";
import LIVEDIFF from "./LiveDiff.tsx?raw";
import CHECKOUT from "../../lib/store.ts?raw";

/** Where both agents add to "rpc.ts": its first exported function. */
const GIT_STATUS = RPC.split("\n").find((l) => l.startsWith("export function"))!;
const S = 1000;
const M = 60 * S;

const RPC_HERON = ["@@ -386,6 +386,9 @@ export interface Methods {", "   \"git.status\": { params: { path: string }; result: GitStatus | null };", "+  /** Every worktree of the repository `path` is in, with what changed in each. */", "+  \"git.worktrees\": { params: { path: string }; result: Worktree[] };", "+", "   \"git.diff\": { params: { path: string; file?: string }; result: { root: string; diff: string; truncated: boolean } | null };"];
const RPC_LARK = ["@@ -386,6 +386,8 @@ export interface Methods {", "   \"git.status\": { params: { path: string }; result: GitStatus | null };", "+  \"mcp.tools\": { params: Record<string, never>; result: McpTool[] };", "+  \"mcp.call\": { params: { tool: string; args: unknown }; result: unknown };", "   \"git.diff\": { params: { path: string; file?: string }; result: { root: string; diff: string; truncated: boolean } | null };", "@@ -512,7 +514,7 @@ export type CoreEvent =", "-  | { type: \"settings.updated\"; settings: Settings }", "+  | { type: \"settings.updated\"; settings: Settings; from?: \"mcp\" }"];
const LIVEDIFF_HERON = ["@@ -32,9 +32,14 @@ const STATE: Record<GitFile[\"state\"], …> = {", " export function LiveDiff({ win }: WindowViewProps) {", "   const dir = stateStr(win, \"path\") ?? \"\";", "-  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);", "+  const worktrees = useWorktrees(dir);", "+  const lanes = useLanes(worktrees);", "+  if (lanes.length > 1) return <ActivityView lanes={lanes} />;", "   const [diff, setDiff] = useState(\"\");"];
const LIVEDIFF_WREN = ["@@ -17,3 +17,3 @@", "-const POLL_MS = 3000;", "+const POLL_MS = 2000;", " /** More files than this start collapsed. */", "-const OPEN_MAX = 6;", "+const OPEN_MAX = 8;"];

/** A stand-in hunk for files the story gives no lines. */
const hunk = (f: { rel: string; added: number; removed: number }) => {
  // About one hunk per 20 added lines, spread through the file, as real changes are.
  const n = Math.max(1, Math.min(12, Math.ceil(f.added / 20)));
  return Array.from({ length: n }, (_, h) => {
    const add = Math.ceil(f.added / n), del = Math.ceil(f.removed / n), at = 12 + h * 57;
    return [
      `@@ -${at},${del + 6} +${at + h * 3},${add + 6} @@ function part${h}() {`,
      `   const value${h} = read(input);`,
      "   if (!value) return null;",
      ...Array.from({ length: del }, (_, i) => `-  legacy(${h}, ${i});`),
      ...Array.from({ length: add }, (_, i) => `+  next.step${i}(value${h}, { from: "${f.rel.split("/").pop()}" });`),
      "   return value;",
      " }",
    ];
  }).flat();
};

const RAW: Lane[] = [
  { id: "main", name: "cmd", branch: "master", main: true, light: "idle", ahead: 0, files: [{ rel: "CHANGELOG.md", state: "modified", added: 4, removed: 0, ago: 42 * M }] },
  {
    id: "a",
    name: "Heron",
    branch: "livediff-worktrees",
    light: "working",
    ahead: 3,
    files: [
      { rel: "apps/desktop/src/renderer/src/windows/diff/LiveDiff.tsx", state: "modified", added: 86, removed: 14, ago: 4 * S, lines: LIVEDIFF_HERON },
      { rel: "packages/core/src/lib/checkout.ts", state: "modified", added: 41, removed: 2, ago: 38 * S },
      { rel: "packages/protocol/src/rpc.ts", state: "modified", added: 3, removed: 0, ago: 2 * M, lines: RPC_HERON },
      { rel: "packages/core/src/lib/git.ts", state: "modified", added: 28, removed: 6, ago: 3 * M, committed: true },
      { rel: "packages/core/test/checkout.test.ts", state: "modified", added: 52, removed: 0, ago: 6 * M, committed: true },
      { rel: "docs/16-widgets.md", state: "modified", added: 9, removed: 3, ago: 9 * M, committed: true },
      { rel: "apps/desktop/src/renderer/src/windows/diff/Activity.story.tsx", state: "untracked", added: 64, removed: 0, ago: 11 * M },
    ],
  },
  {
    id: "b",
    name: "Lark",
    branch: "mcp-context",
    light: "working",
    ahead: 6,
    files: [
      { rel: "packages/protocol/src/rpc.ts", state: "modified", added: 12, removed: 1, ago: 21 * S, lines: RPC_LARK },
      { rel: "packages/core/src/mcp/server.ts", state: "added", added: 210, removed: 0, ago: 50 * S },
      { rel: "packages/core/src/mcp/tools.ts", state: "added", added: 144, removed: 0, ago: 4 * M },
      { rel: "packages/core/src/kernel/features.ts", state: "modified", added: 2, removed: 0, ago: 7 * M, committed: true },
      { rel: "packages/cli/src/commands/mcp.ts", state: "added", added: 61, removed: 0, ago: 12 * M, committed: true },
      { rel: "packages/core/test/mcp.test.ts", state: "added", added: 133, removed: 0, ago: 14 * M, committed: true },
      { rel: "docs/49-mcp.md", state: "added", added: 88, removed: 0, ago: 20 * M, committed: true },
      { rel: "README.md", state: "modified", added: 6, removed: 1, ago: 22 * M, committed: true },
    ],
  },
  {
    id: "c",
    name: "Otter",
    branch: "settings-search",
    light: "needs",
    ahead: 2,
    files: [
      { rel: "apps/desktop/src/renderer/src/settings/layout.ts", state: "modified", added: 7, removed: 2, ago: 2 * M },
      { rel: "packages/protocol/src/settings.ts", state: "modified", added: 18, removed: 0, ago: 5 * M },
      { rel: "apps/desktop/src/renderer/src/settings/Search.tsx", state: "added", added: 97, removed: 0, ago: 8 * M, committed: true },
    ],
  },
  {
    id: "d",
    name: "Wren",
    branch: "tokens-motion",
    light: "working",
    ahead: 11,
    files: [
      { rel: "packages/ui/tokens/motion.tokens.json", state: "modified", added: 22, removed: 9, ago: 9 * S },
      { rel: "packages/ui/src/tokens.css", state: "modified", added: 22, removed: 9, ago: 9 * S },
      { rel: "packages/ui/src/frame.css", state: "modified", added: 5, removed: 5, ago: 1 * M },
      { rel: "apps/desktop/src/renderer/src/windows/diff/LiveDiff.tsx", state: "modified", added: 2, removed: 2, ago: 6 * M, committed: true, lines: LIVEDIFF_WREN },
      ...Array.from({ length: 14 }, (_, i) => ({ rel: `apps/desktop/src/renderer/src/shell/board/part${i}.css`, state: "modified" as const, added: 3, removed: 3, ago: (15 + i) * M, committed: true })),
    ],
  },
  {
    id: "e",
    name: "Finch",
    branch: "competitors",
    light: "done",
    ahead: 1,
    files: [{ rel: "docs/50-competitors.md", state: "added", added: 312, removed: 0, ago: 3 * 60 * M, committed: true }],
  },
];
// Whole texts for the diff pane: real files of this repository where agents share them, made-up code of the right size elsewhere.
const ins = (s: string, after: string, add: string) => s.replace(after, `${after}\n${add}`);
const TEXTS: Record<string, { before: string; after: string }> = {
  "a:packages/protocol/src/rpc.ts": { before: RPC, after: ins(RPC, GIT_STATUS, '  /** Every worktree of the repository `path` is in, with what changed in each. */\n  "git.worktrees": { params: { path: string }; result: Worktree[] };') },
  "b:packages/protocol/src/rpc.ts": { before: RPC, after: ins(RPC, GIT_STATUS, '  "mcp.tools": { params: Record<string, never>; result: McpTool[] };\n  "mcp.call": { params: { tool: string; args: unknown }; result: unknown };') },
  "a:apps/desktop/src/renderer/src/windows/diff/LiveDiff.tsx": {
    before: LIVEDIFF,
    after: LIVEDIFF.replace("  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);", "  const worktrees = useWorktrees(dir);\n  const lanes = useLanes(worktrees);\n  if (lanes.length > 1) return <ActivityView lanes={lanes} />;\n  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);"),
  },
  "d:apps/desktop/src/renderer/src/windows/diff/LiveDiff.tsx": { before: LIVEDIFF, after: LIVEDIFF.replace("const POLL_MS = 3000;", "const POLL_MS = 2000;").replace("const OPEN_MAX = 6;", "const OPEN_MAX = 8;") },
  "a:packages/core/src/lib/checkout.ts": {
    before: CHECKOUT,
    after: `${CHECKOUT}\n/** Every worktree of the repository \`common\` is the git folder of: <common>/worktrees/<name>/gitdir names each. */\nexport function worktreesOf(common: string): string[] {\n  let names: string[] = [];\n  try {\n    names = fs.readdirSync(path.join(common, "worktrees"));\n  } catch {\n    return [];\n  }\n  return names.flatMap((n) => {\n    try {\n      return [path.dirname(fs.readFileSync(path.join(common, "worktrees", n, "gitdir"), "utf8").trim())];\n    } catch {\n      return [];\n    }\n  });\n}\n`,
  },
};

/** Made-up code for a file: `n` lines of small functions. */
const code = (rel: string, n: number, tag = "") =>
  [`// ${rel.split("/").pop()}`, "", ...Array.from({ length: n }, (_, i) => (i % 6 === 0 ? `export function step${i}${tag}(input: Input) {` : i % 6 === 5 ? "}" : `  const v${i} = read(input, ${i});`))].join("\n");
/** A made-up file before and after: `added` and `removed` lines in a few places through it. */
function synth(f: { rel: string; state: string; added: number; removed: number }) {
  if (f.state === "added" || f.state === "untracked") return { before: "", after: code(f.rel, f.added - 2, "New") };
  const before = code(f.rel, Math.max(60, f.removed * 3 + f.added));
  if (f.state === "deleted") return { before, after: "" };
  const lines = before.split("\n");
  const n = Math.max(1, Math.ceil(f.added / 15));
  for (let k = n - 1; k >= 0; k--) {
    const at = 4 + Math.floor(((lines.length - 8) * (k + 0.5)) / n);
    lines.splice(at, Math.ceil(f.removed / n), ...Array.from({ length: Math.ceil(f.added / n) }, (_, i) => `  next.step${i}(v${at}, "${k}");`));
  }
  return { before, after: lines.join("\n") };
}

const LANES: Lane[] = RAW.map((l) => ({ ...l, files: l.files.map((f) => ({ ...f, lines: f.lines ?? hunk(f), ...(TEXTS[`${l.id}:${f.rel}`] ?? synth(f)) })) }));

function W({ size = "regular", lanes = LANES, lens, open }: { size?: SizeName; lanes?: Lane[]; lens?: "agents" | "files"; open?: string }) {
  return (
    <RefWindow icon="plus-minus" name="Changes · cmd" size={size}>
      <ActivityView lanes={lanes} initialLens={lens} initialSelected={open} />
    </RefWindow>
  );
}

/** Five agents and the main checkout; Heron and Lark both changed rpc.ts, Heron and Wren LiveDiff.tsx. Working agents start open. */
export const ByAgent = () => <W />;
/** rpc.ts opened from the overlaps: Lark's change, then Heron's, each under its own line. */
export const SharedFileOpen = () => <W open="shared:packages/protocol/src/rpc.ts" />;
/** A file opened under its agent: one diff, no per-agent line. */
export const AgentFileOpen = () => <W open="a:packages/core/src/lib/checkout.ts" />;
/** The same files by area, each with who changed it. */
export const ByArea = () => <W lens="files" />;
/** One agent alone: no overlap section. */
export const OneAgent = () => <W lanes={LANES.slice(1, 2)} />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;

/** This repository for real, through the core: every active checkout of ~/src/cmd as Live Diff shows it. */
export const ThisRepository = () => <Real dir="~/src/cmd" />;

function Real({ dir }: { dir: string }) {
  const data = useWorktrees(dir);
  const agents = useStoreValue((s) => s.agents);
  const lanes = useMemo(() => (data ? lanesOf(data, agents.values(), Date.now()) : []), [data, agents]);
  return (
    <RefWindow icon="plus-minus" name="Changes · cmd" size="regular">
      <ActivityView lanes={lanes} load={(lane, rel) => cmd.call("git.fileVersions", { top: lane.top!, file: rel, base: lane.base ?? null })} />
    </RefWindow>
  );
}
