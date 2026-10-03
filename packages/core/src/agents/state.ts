// Hook event → agent state. Ported from ghostty-agents AgentStatusStore,
// extended for Codex hooks (same event names). See docs/05-agent-integration.md.

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

export function applyHook(kind: AgentKind, event: string, p: Payload): StateChange {
  const change: StateChange = {};
  const sessionId = str(p.session_id);
  if (sessionId) {
    change.native = nativeSession(kind, sessionId);
    const tp = str(p.transcript_path);
    if (tp) change.native.transcriptPath = tp;
  }
  const cwd = str(p.cwd);
  if (cwd) change.cwd = cwd;

  // Events fired from inside a Claude subagent carry agent_id; they describe the child.
  const subId = str(p.agent_id);

  switch (event) {
    case "SessionStart":
      change.state = "idle";
      change.detail = null;
      break;
    case "UserPromptSubmit":
      change.state = "working";
      change.detail = null;
      break;
    case "PreToolUse":
      if (subId) break;
      change.state = "working";
      change.detail = describeTool(str(p.tool_name), p.tool_input as Payload | undefined);
      break;
    case "PostToolUse":
    case "PostToolUseFailure":
    case "PreCompact":
    case "PostCompact":
      if (subId) break;
      change.state = "working";
      break;
    case "PermissionRequest":
      change.state = "needs_input";
      change.detail = str(p.message) ?? `Allow ${str(p.tool_name) ?? "tool"}?`;
      break;
    case "Notification": {
      const type = str(p.notification_type);
      if (type === "idle_prompt") break; // reminder that it is waiting; Stop already said done
      change.state = "needs_input";
      change.detail = str(p.message) ?? "Needs input";
      break;
    }
    case "Stop":
      change.state = "done";
      change.detail = null;
      if (str(p.last_assistant_message)) change.lastMessage = str(p.last_assistant_message);
      break;
    case "StopFailure":
      change.state = "failed";
      change.detail = str(p.error) ?? "Request failed";
      break;
    case "SessionEnd":
      change.state = "exited";
      change.detail = null;
      break;
    case "SubagentStart":
      if (subId) change.subagent = { op: "start", id: subId, type: str(p.agent_type) };
      break;
    case "SubagentStop":
      if (subId)
        change.subagent = { op: "stop", id: subId, lastMessage: str(p.last_assistant_message) };
      break;
  }
  return change;
}

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
