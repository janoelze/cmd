// Editing a file in the workspace in an editor window the person sees, with the diff asked for
// first. Only for callers that can't edit files themselves (a model in a widget); coding
// agents edit with their own tools.

import path from "node:path";
import { readablePath, schema, str, type ToolContext, type Input, type Tool } from "./kit.ts";

/** Lines that differ between `a` and `b`, with a little context: `- ` removed, `+ ` added. At most `max` lines. */
export function lineDiff(a: string, b: string, max = 80): string {
  const x = a.split("\n");
  const y = b.split("\n");
  let head = 0;
  while (head < x.length && head < y.length && x[head] === y[head]) head++;
  let tail = 0;
  while (tail < x.length - head && tail < y.length - head && x[x.length - 1 - tail] === y[y.length - 1 - tail]) tail++;
  const ctx = 2;
  const out = [
    ...(head > ctx ? [`@@ line ${head - ctx + 1}`] : []),
    ...x.slice(Math.max(0, head - ctx), head).map((l) => `  ${l}`),
    ...x.slice(head, x.length - tail).map((l) => `- ${l}`),
    ...y.slice(head, y.length - tail).map((l) => `+ ${l}`),
    ...x.slice(x.length - tail, x.length - tail + ctx).map((l) => `  ${l}`),
  ];
  return out.length > max ? [...out.slice(0, max), `… ${out.length - max} more lines`].join("\n") : out.join("\n");
}

/** A path to write: as for reading, and never inside .git or node_modules. */
function writablePath(b: ToolContext, p: string): string {
  const abs = readablePath(b, p);
  if (/(^|\/)(\.git|node_modules)(\/|$)/.test(path.relative(b.workspace().root, abs))) throw new Error(`${p} isn't a file to edit`);
  return abs;
}

/** What an edit makes of the file: its text before (null: a new file) and after. Throws a message the model can act on. */
async function planEdit(i: Input, b: ToolContext): Promise<{ abs: string; rel: string; before: string | null; after: string; mtime: number | undefined }> {
  const abs = writablePath(b, String(i.path ?? ""));
  const rel = path.relative(b.workspace().root, abs);
  let before: string | null = null;
  let mtime: number | undefined;
  try {
    const f = await b.call("fs.read", { path: abs });
    if (f.binary || f.truncated) throw new Error(`${rel} is ${f.binary ? "binary" : "too large"}: start an agent to change it`);
    before = f.text;
    mtime = f.mtime;
  } catch (e) {
    if (!/ENOENT|no such file/i.test((e as Error).message)) throw e;
  }
  if (before === null) {
    const dir = path.dirname(abs);
    const listed = await b.call("fs.list", { path: dir }).catch(() => null);
    if (!listed) throw new Error(`the folder ${path.relative(b.workspace().root, dir)} doesn't exist: new files go into folders that do (an agent can make folders)`);
  }
  if (typeof i.content === "string") return { abs, rel, before, after: i.content, mtime };
  if (before === null) throw new Error(`${rel} doesn't exist: give its whole content to create it`);
  const find = str(i.find);
  if (!find) throw new Error("give find and replace, or the whole content");
  const n = before.split(find).length - 1;
  if (n === 0) throw new Error(`find isn't in ${rel}: read it and copy the text exactly`);
  if (n > 1 && !i.all) throw new Error(`find is in ${rel} ${n} times: give more of the surrounding text, or all: true`);
  return { abs, rel, before, after: i.all ? before.split(find).join(String(i.replace ?? "")) : before.replace(find, () => String(i.replace ?? "")), mtime };
}

const editTool: Tool = {
  acts: true,
  calls: ["window.list", "window.open", "fs.read", "fs.list", "fs.write"],
  for: "models",
  spec: {
    name: "edit",
    explores: false,
    description:
      "Change a file in the workspace's folder, or create one, in an editor window the person sees. For small, clear changes: a line in a config, a typo, a note, a short new file. Give `find` (text copied exactly from the file, enough to be unique) and `replace`, or `content` for a new file or a whole rewrite. Always asks the person first, showing the diff. Larger changes, or ones that need code run and checked, go to a coding agent (agent).",
    schema: schema({ path: { type: "string", description: "Relative to the workspace's folder." }, find: { type: "string" }, replace: { type: "string" }, all: { type: "boolean", description: "Replace every occurrence of find." }, content: { type: "string" } }, ["path"]),
  },
  async confirm(i, b) {
    const e = await planEdit(i, b);
    if (e.before === e.after) throw new Error(`that changes nothing in ${e.rel}`);
    return { permission: "edit", title: e.before === null ? `Create ${e.rel}` : `Edit ${e.rel}`, exact: e.before === null ? lineDiff("", e.after).replace(/^- $/m, "") : lineDiff(e.before, e.after) };
  },
  async run(i, b) {
    const e = await planEdit(i, b);
    // In an editor, so the person sees the change land (it reloads from disk); one already showing it if there is one.
    const shown = (await b.call("window.list", {})).find((w) => w.workspaceId === b.workspace().id && w.kind === "text" && w.state.path === e.abs);
    const w = shown ?? (e.before === null ? null : await b.call("window.open", { kind: "text", input: { path: e.abs }, workspaceId: b.workspace().id, openerId: b.caller.windowId ?? undefined }));
    // expectMtime: refused if the file changed on disk since it was read.
    await b.call("fs.write", { path: e.abs, text: e.after, expectMtime: e.mtime });
    const opened = w ?? (await b.call("window.open", { kind: "text", input: { path: e.abs }, workspaceId: b.workspace().id, openerId: b.caller.windowId ?? undefined }));
    return `${e.before === null ? "Created" : "Changed"} ${e.rel}, shown in ${b.refs.of(opened.id)}.`;
  },
};

export const EDIT_TOOLS: Tool[] = [editTool];
