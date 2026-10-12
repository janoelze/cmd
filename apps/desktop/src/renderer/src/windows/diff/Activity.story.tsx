// Live Diff across worktrees (prototype): five agents in worktrees of one project and
// the main checkout, two of them on the same files; by agent and by area; one agent;
// every size.

import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { ActivityView, type Lane } from "./Activity.tsx";

const S = 1000;
const M = 60 * S;

const RPC_HERON = ["@@ -386,6 +386,9 @@ export interface Methods {", "   \"git.status\": { params: { path: string }; result: GitStatus | null };", "+  /** Every worktree of the repository `path` is in, with what changed in each. */", "+  \"git.worktrees\": { params: { path: string }; result: Worktree[] };", "+", "   \"git.diff\": { params: { path: string; file?: string }; result: { root: string; diff: string; truncated: boolean } | null };"];
const RPC_LARK = ["@@ -386,6 +386,8 @@ export interface Methods {", "   \"git.status\": { params: { path: string }; result: GitStatus | null };", "+  \"mcp.tools\": { params: Record<string, never>; result: McpTool[] };", "+  \"mcp.call\": { params: { tool: string; args: unknown }; result: unknown };", "   \"git.diff\": { params: { path: string; file?: string }; result: { root: string; diff: string; truncated: boolean } | null };", "@@ -512,7 +514,7 @@ export type CoreEvent =", "-  | { type: \"settings.updated\"; settings: Settings }", "+  | { type: \"settings.updated\"; settings: Settings; from?: \"mcp\" }"];
const LIVEDIFF_HERON = ["@@ -32,9 +32,14 @@ const STATE: Record<GitFile[\"state\"], …> = {", " export function LiveDiff({ win }: WindowViewProps) {", "   const dir = stateStr(win, \"path\") ?? \"\";", "-  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);", "+  const worktrees = useWorktrees(dir);", "+  const lanes = useLanes(worktrees);", "+  if (lanes.length > 1) return <ActivityView lanes={lanes} />;", "   const [diff, setDiff] = useState(\"\");"];
const LIVEDIFF_WREN = ["@@ -17,3 +17,3 @@", "-const POLL_MS = 3000;", "+const POLL_MS = 2000;", " /** More files than this start collapsed. */", "-const OPEN_MAX = 6;", "+const OPEN_MAX = 8;"];

/** A stand-in hunk for files the story gives no lines. */
const hunk = (f: { rel: string; added: number; removed: number }) => [
  `@@ -1,${f.removed + 2} +1,${f.added + 2} @@`,
  ` // ${f.rel.split("/").pop()}`,
  ...Array.from({ length: Math.min(f.removed, 4) }, (_, i) => `-  old line ${i + 1}`),
  ...Array.from({ length: Math.min(f.added, 6) }, (_, i) => `+  new line ${i + 1}`),
  ...(f.added > 6 ? [`+  … ${f.added - 6} more`] : []),
  " ",
];

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
const LANES: Lane[] = RAW.map((l) => ({ ...l, files: l.files.map((f) => ({ ...f, lines: f.lines ?? hunk(f) })) }));

function W({ size = "regular", lanes = LANES, lens, open }: { size?: SizeName; lanes?: Lane[]; lens?: "agents" | "files"; open?: string[] }) {
  return (
    <RefWindow icon="plusminus" name="Changes · cmd" size={size}>
      <ActivityView lanes={lanes} initialLens={lens} initialOpen={open} />
    </RefWindow>
  );
}

/** Five agents and the main checkout; Heron and Lark both changed rpc.ts, Heron and Wren LiveDiff.tsx. Working agents start open. */
export const ByAgent = () => <W />;
/** rpc.ts opened from the overlaps: Lark's change, then Heron's, each under its own line. */
export const SharedFileOpen = () => <W size="wide" open={["shared:packages/protocol/src/rpc.ts"]} />;
/** A file opened under its agent: one diff, no per-agent line. */
export const AgentFileOpen = () => <W open={["a:packages/core/src/lib/checkout.ts"]} />;
/** The same files by area, each with who changed it. */
export const ByArea = () => <W lens="files" />;
/** One agent alone: no overlap section. */
export const OneAgent = () => <W lanes={LANES.slice(1, 2)} />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;
