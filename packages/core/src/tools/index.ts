// The tools (docs/54, One source): a dozen task-shaped verbs over the core's methods, written by
// hand around what a person does with a workspace, each calling cmd's methods through its
// ToolContext, which checks TOOL_ACCESS first. Every input carries `why`, the line the board
// shows. A tool says whether it acts (marked on the board, run one at a time) and, for a call
// that needs the person's approval, exactly what it asks. MCP (`cmd mcp`), the CLI (`cmd tools`)
// and the model in a widget all read this list; none defines a tool of its own.

import type { Tool } from "./kit.ts";
import { WORKSPACE_TOOLS } from "./workspace.ts";
import { ACTION_TOOLS } from "./actions.ts";
import { AGENT_TOOLS } from "./agents.ts";
import { EDIT_TOOLS } from "./edit.ts";
import { WINDOW_TOOLS } from "./windows.ts";
import { PAGE_TOOLS } from "./pages.ts";

export type { Approval, Caller, Tool, ToolContext } from "./kit.ts";
export { windowName } from "./kit.ts";
export { lineDiff } from "./edit.ts";

const by = (name: string) => [...WORKSPACE_TOOLS, ...ACTION_TOOLS, ...AGENT_TOOLS, ...EDIT_TOOLS, ...WINDOW_TOOLS, ...PAGE_TOOLS].find((t) => t.spec.name === name)!;

/** Every tool, in the order models see them. */
export const TOOLS: Tool[] = ["look", "read", "run", "agent", "wait", "type", "edit", "open", "close", "focus", "arrange", "page", "search", "events"].map(by);
