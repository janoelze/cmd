// The tools for the board itself (docs/54, docs/51): open a window (or show something else in
// one), close, select, and arrange: dock, back to the board, place in the order, the view, or
// another workspace. The board's layout is the app's, so arranging asks it (workspace.arrange).

import path from "node:path";
import type { AppWindow } from "@cmd/protocol";
import { otherWindow, readablePath, ref, schema, str, windowName, windowOf, type Tool } from "./kit.ts";

/** A web address to open: http or https only. */
function urlOf(target: string | undefined): URL {
  let url: URL;
  try {
    url = new URL(target ?? "");
  } catch {
    throw new Error("a URL starts with http:// or https://");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") throw new Error("a URL starts with http:// or https://");
  return url;
}

const openTool: Tool = {
  acts: true,
  spec: {
    name: "open",
    explores: false,
    description:
      "Open a window in the workspace: a terminal (in a folder of the workspace), a file or folder (in the window type that shows it), or a URL in a browser. Returns its ref. With `ref`, the window already open shows it instead: a browser goes to the URL, a file browser to the folder (prefer this to opening another window). A URL asks the person first, unless they allow its site here. To run a command, open nothing: use run or type.",
    schema: schema({ kind: { type: "string", enum: ["terminal", "path", "url"] }, target: { type: "string", description: "The path (relative to the workspace's folder) or URL; for a terminal, the folder to start in." }, ref: { ...ref, description: "A browser or file browser to show it in, instead of a new window." } }, ["kind"]),
  },
  target: (i, b) => (i.ref ? b.refs.id(i.ref) : null),
  // A URL asks first: a page can tell a model to visit an address carrying what it read. Remembered per site.
  async confirm(i) {
    if (i.kind !== "url") return null;
    const url = urlOf(str(i.target));
    const site = url.hostname.replace(/^www\./, "");
    return { title: `Open ${site}`, exact: url.href, rule: { key: `url:${site}`, label: `opening pages on ${site}` } };
  },
  async run(i, b) {
    const ws = b.workspace();
    const target = str(i.target);
    if (i.ref) {
      const w = await windowOf(b, i.ref);
      if (w.kind === "browser" && i.kind === "url") {
        await b.call("window.update", { id: w.id, state: { url: urlOf(target).href } });
        return `${String(i.ref)} goes to ${target}.`;
      }
      if (w.kind === "files" && i.kind === "path") {
        const dir = readablePath(b, target ?? ".");
        await b.call("window.update", { id: w.id, state: { path: dir } });
        return `${String(i.ref)} shows ${path.relative(ws.root, dir) || "the workspace's folder"}.`;
      }
      throw new Error(`${String(i.ref)} is ${windowName(w)}: only a browser takes a URL and a file browser a folder; open a new window instead`);
    }
    let w: AppWindow | null;
    if (i.kind === "terminal") w = await b.call("window.open", { kind: "terminal", input: { cwd: target ? readablePath(b, target) : ws.root }, workspaceId: ws.id });
    else if (i.kind === "url") w = await b.call("window.open", { kind: "browser", input: { url: urlOf(target).href }, workspaceId: ws.id }); else w = await b.call("window.openTarget", { target: readablePath(b, target ?? "."), workspaceId: ws.id });
    if (!w) return "No window type shows that; nothing opened.";
    return `Opened ${w.kind} ${b.refs.of(w.id)} "${w.title}".`;
  },
};

const closeTool: Tool = {
  acts: true,
  spec: {
    name: "close",
    explores: false,
    description: "Close windows by ref. A terminal's running command or agent ends with it, so close only what is done or what you opened; the person can reopen closed windows.",
    schema: schema({ refs: { type: "array", items: ref } }, ["refs"]),
  },
  target: (i, b) => (Array.isArray(i.refs) && i.refs.length === 1 ? b.refs.id(i.refs[0]) : null),
  async run(i, b) {
    const wins = await Promise.all((Array.isArray(i.refs) ? i.refs : []).map((r) => otherWindow(b, r, "close")));
    for (const w of wins) await b.call("window.close", { id: w.id });
    return `Closed ${wins.map((w) => b.refs.of(w.id)).join(", ")}.`;
  },
};

const focusTool: Tool = {
  acts: true,
  spec: {
    name: "focus",
    explores: false,
    description: "Select a window and bring it into view, to show the person something (a failing test's output, a finished agent).",
    schema: schema({ ref }, ["ref"]),
  },
  target: (i, b) => b.refs.id(i.ref),
  async run(i, b) {
    const w = await windowOf(b, i.ref);
    await b.call("window.select", { id: w.id });
    return `Selected ${String(i.ref)}.`;
  },
};

const arrangeTool: Tool = {
  acts: true,
  spec: {
    name: "arrange",
    explores: false,
    description:
      "Move windows on the board: `dock` one into the left or right sidebar, put one back on the `board`, `place` one before or after another window (or first or last) in the board's order, switch the board's `mode` (grid, strip, canvas, or focus: the selected window alone), or `move` one to another workspace by its name. Use it when the person asks for a layout, or to put two windows side by side that they should compare.",
    schema: schema(
      {
        do: { type: "string", enum: ["dock", "board", "place", "mode", "move"] },
        ref: { ...ref, description: "The window to move (not for mode)." },
        side: { type: "string", enum: ["left", "right"], description: "dock: which sidebar." },
        before: { ...ref, description: "place: before this window." },
        after: { ...ref, description: "place: after this window." },
        to: { type: "string", description: "place: first or last; move: the workspace's name." },
        mode: { type: "string", enum: ["grid", "strip", "canvas", "focus"] },
      },
      ["do"],
    ),
  },
  target: (i, b) => (i.ref ? b.refs.id(i.ref) : null),
  async run(i, b) {
    const ws = b.workspace();
    if (i.do === "mode") {
      const mode = str(i.mode);
      if (mode !== "grid" && mode !== "strip" && mode !== "canvas" && mode !== "focus") throw new Error("mode is grid, strip, canvas or focus");
      await b.call("workspace.arrange", { workspaceId: ws.id, move: { op: "mode", mode } });
      return `The board shows ${mode === "focus" ? "the selected window alone" : `as ${mode}`}.`;
    }
    const w = await windowOf(b, i.ref);
    if (w.id === b.caller.windowId && i.do !== "dock" && i.do !== "board") throw new Error("your own window stays where the person put it");
    if (i.do === "move") {
      const name = str(i.to)?.trim().toLowerCase();
      const there = (await b.call("workspace.list", {})).find((x) => x.name.toLowerCase() === name);
      if (!there) throw new Error(`no workspace "${str(i.to)}": ${(await b.call("workspace.list", {})).map((x) => x.name).join(", ")}`);
      await b.call("window.move", { id: w.id, workspaceId: there.id });
      return `Moved ${windowName(w)} to the workspace “${there.name}”.`;
    }
    if (i.do === "dock") {
      const side = i.side === "left" ? "left" : "right";
      await b.call("workspace.arrange", { workspaceId: ws.id, move: { op: "dock", id: w.id, side } });
      return `Docked ${windowName(w)} on the ${side}.`;
    }
    if (i.do === "board") {
      await b.call("workspace.arrange", { workspaceId: ws.id, move: { op: "board", id: w.id } });
      return `Put ${windowName(w)} back on the board.`;
    }
    const to = str(i.to) === "first" || str(i.to) === "last" ? (str(i.to) as "first" | "last") : undefined;
    const before = i.before ? b.refs.id(i.before) : undefined;
    const after = i.after ? b.refs.id(i.after) : undefined;
    if (!to && !before && !after) throw new Error("place needs before, after, or to: first or last");
    await b.call("workspace.arrange", { workspaceId: ws.id, move: { op: "place", id: w.id, before, after, to } });
    return `Placed ${windowName(w)}${before ? ` before ${String(i.before)}` : after ? ` after ${String(i.after)}` : ` ${to}`}.`;
  },
};

export const WINDOW_TOOLS: Tool[] = [openTool, closeTool, focusTool, arrangeTool];
