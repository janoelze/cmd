// Shared pieces of reading hook events: the state change the tracker applies,
// event names across agents, and short descriptions of tool calls. Events become
// state in activity/reduce.ts. See docs/05-agent-integration.md.

import type { AgentKind, AgentState } from "@cmd/protocol";

export interface StateChange {
  state?: AgentState;
  /** undefined = keep, null = clear */
  detail?: string | null;
  lastMessage?: string;
  native?: { claudeSessionId?: string; codexThreadId?: string; transcriptPath?: string };
  cwd?: string;
  /** In-process subagent lifecycle (Claude SubagentStart/Stop). */
  subagent?: { op: "start" | "stop"; id: string; type?: string; lastMessage?: string };
}

type Payload = Record<string, unknown>;
const str = (v: unknown): string | undefined => (typeof v === "string" && v ? v : undefined);

/** Where an agent's own session id is kept (Codex calls it a thread). */
export function nativeSession(kind: AgentKind, sessionId: string): { claudeSessionId?: string; codexThreadId?: string } {
  return kind === "codex" ? { codexThreadId: sessionId } : { claudeSessionId: sessionId };
}

/** Gemini CLI's names for the hook events Claude and Codex share; the rest are the same or unused. */
const GEMINI_EVENTS: Record<string, string> = { BeforeAgent: "UserPromptSubmit", AfterAgent: "Stop", BeforeTool: "PreToolUse", AfterTool: "PostToolUse", PreCompress: "PreCompact" };

/** The Claude/Codex name of an agent's hook event. */
export const hookEventName = (kind: string | null, event: string): string => (kind === "gemini" && GEMINI_EVENTS[event]) || event;

const base = (p: unknown): string | null => (typeof p === "string" && p ? (p.split(/[\\/]/).pop() ?? p) : null);
const line1 = (s: string) => (s.split(/\r?\n/)[0] ?? s).trim();

/** Short description of a tool call. Port of the fork's describeTool. */
export function describeTool(tool?: string, input?: Payload): string | null {
  if (!tool) return null;
  const i = input ?? {};
  const file = (key = "file_path") => base(i[key]);
  switch (tool) {
    case "Bash":
    case "shell":
    case "exec_command": {
      const d = str(i.description) ?? str(i.command) ?? (Array.isArray(i.command) ? i.command.join(" ") : undefined);
      return d ? line1(d) : tool;
    }
    case "Edit":
    case "MultiEdit":
      return file() ? `Editing ${file()}` : "Editing";
    case "apply_patch":
      return "Editing files";
    case "Write":
      return file() ? `Writing ${file()}` : "Writing";
    case "Read":
      return file() ? `Reading ${file()}` : "Reading";
    case "NotebookEdit":
      return file("notebook_path") ? `Editing ${file("notebook_path")}` : "Editing notebook";
    case "Grep":
    case "Glob":
      return str(i.pattern) ? `Searching ${str(i.pattern)}` : "Searching";
    case "WebFetch": {
      let host: string | null = null;
      try {
        host = str(i.url) ? new URL(str(i.url)!).host : null;
      } catch {}
      return host ? `Fetching ${host}` : "Fetching";
    }
    case "WebSearch":
      return str(i.query) ? `Searching the web: ${str(i.query)}` : "Searching the web";
    case "Task":
    case "Agent":
      return str(i.description) ? `Subagent: ${str(i.description)}` : "Subagent";
    case "TodoWrite":
      return "Updating todos";
    default:
      // MCP tools are named mcp__<server>__<tool>.
      return tool.startsWith("mcp__") ? tool.split("_").filter(Boolean).slice(1).join(" ") : tool;
  }
}
