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

/**
 * Tools that are the question itself (Claude's AskUserQuestion and plan approval, Codex's
 * request_user_input): their end is the answer. While one is up the user moves through its
 * options, which redraws the screen, so output says nothing about it being answered or dismissed.
 */
export const QUESTIONS = new Set(["AskUserQuestion", "ExitPlanMode", "request_user_input"]);

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
    case "exec_command":
    case "run_shell_command": {
      const d = str(i.description) ?? str(i.command) ?? (Array.isArray(i.command) ? i.command.join(" ") : undefined);
      return d ? line1(d) : tool;
    }
    case "Edit":
    case "MultiEdit":
    case "replace":
    case "edit":
      return file() ? `Editing ${file()}` : "Editing";
    case "apply_patch":
      return "Editing files";
    case "Write":
    case "write_file":
      return file() ? `Writing ${file()}` : "Writing";
    case "Read":
    case "read_file":
      return file() ? `Reading ${file()}` : "Reading";
    case "read_many_files":
      return "Reading files";
    case "list_directory":
    case "LS":
      return file("dir_path") ?? file("path") ? `Listing ${file("dir_path") ?? file("path")}` : "Listing";
    case "NotebookEdit":
      return file("notebook_path") ? `Editing ${file("notebook_path")}` : "Editing notebook";
    case "Grep":
    case "Glob":
    case "glob":
    case "grep_search":
    case "search_file_content":
      return str(i.pattern) ? `Searching ${str(i.pattern)}` : "Searching";
    case "WebFetch":
    case "web_fetch": {
      let host: string | null = null;
      try {
        host = str(i.url) ? new URL(str(i.url)!).host : null;
      } catch {}
      return host ? `Fetching ${host}` : "Fetching";
    }
    case "WebSearch":
    case "google_web_search":
      return str(i.query) ? `Searching the web: ${str(i.query)}` : "Searching the web";
    case "Task":
    case "Agent":
      return str(i.description) ? `Subagent: ${str(i.description)}` : "Subagent";
    case "invoke_agent":
      return str(i.agent_name) ? `Subagent: ${str(i.agent_name)}` : "Subagent";
    case "update_topic":
      return str(i.strategic_intent) ? `Planning: ${line1(str(i.strategic_intent)!)}` : "Planning";
    case "complete_task":
      return "Finishing up";
    case "TodoWrite":
      return "Updating todos";
    default:
      // MCP tools are named mcp__<server>__<tool>.
      return tool.startsWith("mcp__") ? tool.split("_").filter(Boolean).slice(1).join(" ") : tool;
  }
}
