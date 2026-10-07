// Agent names (docs/32-session-names.md): 1–3 nouns cmd owns, that tell the
// agents in a Space apart in notifications, rows and `cmd send`. Where a name
// comes from, how a branch becomes one, and how a typed reference finds an
// agent by id or name. Pure, shared by the core, the CLI and the renderer.

import type { Agent, AgentKind, SpaceId } from "./model.ts";

/** Who gave an agent its name: the person, its worktree's branch, a model. */
export type NameSource = "user" | "worktree" | "model";

/**
 * The language cmd writes in: names, notification wording, the journal,
 * summaries. English until the UI is translated; every model prompt asks for
 * this rather than saying "English" itself.
 */
export function outputLanguage(): { code: string; name: string } {
  return { code: "en", name: "English" };
}

const KIND_LABELS: Record<string, string> = { claude: "Claude", codex: "Codex", gemini: "Gemini", opencode: "OpenCode", qwen: "Qwen", copilot: "Copilot" };

/** What an agent without a name is called: its kind, as a word ("Claude"). */
export function kindLabel(kind: AgentKind): string {
  return KIND_LABELS[kind] ?? (kind ? kind[0]!.toUpperCase() + kind.slice(1) : "Agent");
}

/** An agent's name, else its kind. */
export function agentName(a: Pick<Agent, "name" | "kind">): string {
  return a.name || kindLabel(a.kind);
}

/** Branches that are a repository's main line, not a task. */
const MAIN_BRANCHES = new Set(["master", "main", "trunk", "develop", "dev", "HEAD"]);
/** Prefixes that say what kind of branch, not what it's about. */
const BRANCH_PREFIX = /^(?:(?:feature|feat|fix|bugfix|hotfix|chore|refactor|wip)[_-]|[\w.-]{1,16}\/)/i;

/**
 * A branch as a name: "notify-permission" → "Notify permission". Null for a
 * main line, or a branch that is only an id or longer than three words (a
 * model shortens those).
 */
export function nameFromBranch(branch: string | null | undefined): string | null {
  if (!branch || MAIN_BRANCHES.has(branch)) return null;
  let b = branch.replace(BRANCH_PREFIX, "");
  // Ticket ids ("ABC-123-") and trailing dates or numbers say nothing a person reads.
  b = b.replace(/^[A-Z]{2,10}-\d+[-_]?/, "").replace(/[-_]\d{2,}$/, "");
  const words = b.split(/[-_./\s]+/).filter(Boolean);
  if (!words.length || words.length > 3 || words.every((w) => /^\d+$/.test(w))) return null;
  const text = words.join(" ");
  return text[0]!.toUpperCase() + text.slice(1);
}

/** A name or reference compared loosely: case, spaces, dashes and underscores ignored. */
export function nameKey(s: string): string {
  return s.toLowerCase().replace(/[\s_-]+/g, "");
}

/** How long a renamed agent still answers to its old name. */
export const FORMER_NAME_MS = 60 * 60_000;

/**
 * The live agents a typed reference means: an id or id prefix first, then a
 * name (loosely, or the start of one of its words), in the caller's Space
 * before the others, then a name an agent had in the last hour. More than one
 * means ambiguous: the caller lists them, never picks.
 */
export function matchAgents<A extends Pick<Agent, "id" | "name" | "spaceId"> & { nameWas?: string | null; namedAt?: number | null }>(agents: A[], ref: string, o: { spaceId?: SpaceId | null; now?: number } = {}): A[] {
  if (!ref) return [];
  const byId = agents.filter((a) => a.id === ref);
  if (byId.length) return byId;
  const byPrefix = agents.filter((a) => a.id.startsWith(ref));
  if (byPrefix.length) return byPrefix;
  const key = nameKey(ref);
  if (!key) return [];
  const words = (n: string) => n.toLowerCase().split(/[\s_-]+/).filter(Boolean);
  const exact = (a: A) => !!a.name && nameKey(a.name) === key;
  const start = (a: A) => !!a.name && (nameKey(a.name).startsWith(key) || words(a.name).some((w) => w.startsWith(ref.toLowerCase())));
  const now = o.now ?? Date.now();
  const former = (a: A) => !!a.nameWas && nameKey(a.nameWas) === key && now - (a.namedAt ?? 0) < FORMER_NAME_MS && !agents.some((b) => exact(b));
  const inSpace = (a: A) => !o.spaceId || a.spaceId === o.spaceId;
  for (const rule of [exact, start, former]) {
    const here = agents.filter((a) => inSpace(a) && rule(a));
    if (here.length) return here;
    const all = agents.filter(rule);
    if (all.length) return all;
  }
  return [];
}
