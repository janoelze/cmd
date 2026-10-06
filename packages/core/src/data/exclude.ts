// What cmd never records (docs/28 §7; research 27 §7: not storing beats
// redacting later). The `data.exclude` setting is a comma-separated list:
//   ~/private, /Volumes/work     folders: nothing that happens in them (commands, agents, transcripts, files)
//   host:bank.example            pages on that host and its subdomains
//   cmd:^op\s, cmd:security      commands matching the regular expression
// Applied when an event is recorded, and to what's already kept by `cmd data prune --rules`.

import os from "node:os";
import path from "node:path";
import type { NewDataEvent } from "@cmd/protocol";

export interface ExcludeRules {
  folders: string[];
  hosts: string[];
  commands: RegExp[];
  /** Entries that couldn't be read (a bad regular expression), for the settings to show. */
  errors: string[];
}

export function parseExclude(setting: string, home = os.homedir()): ExcludeRules {
  const r: ExcludeRules = { folders: [], hosts: [], commands: [], errors: [] };
  for (const raw of setting.split(",").map((s) => s.trim()).filter(Boolean)) {
    if (raw.startsWith("host:")) r.hosts.push(raw.slice(5).trim().toLowerCase().replace(/^\*\./, ""));
    else if (raw.startsWith("cmd:")) {
      try {
        r.commands.push(new RegExp(raw.slice(4).trim()));
      } catch {
        r.errors.push(raw);
      }
    } else if (raw === "~" || raw.startsWith("~/") || raw.startsWith("/")) r.folders.push(path.resolve(raw === "~" ? home : raw.startsWith("~/") ? path.join(home, raw.slice(2)) : raw));
    else r.errors.push(raw);
  }
  return r;
}

const under = (p: string, dir: string) => p === dir || p.startsWith(dir.endsWith("/") ? dir : `${dir}/`);

/** The folders an event happened in, from its project and its payload. */
function foldersOf(e: NewDataEvent): string[] {
  const out: string[] = [];
  if (e.projectId?.startsWith("dir:")) out.push(e.projectId.slice(4));
  const d = e.data as Record<string, unknown> | null;
  for (const k of ["cwd", "path", "repo", "worktree"]) if (d && typeof d[k] === "string") out.push(d[k] as string);
  const payload = d && typeof d.payload === "object" && d.payload ? (d.payload as Record<string, unknown>) : null;
  if (payload && typeof payload.cwd === "string") out.push(payload.cwd);
  return out;
}

/** Why an event isn't recorded, or null when it may be. */
export function excludedBy(rules: ExcludeRules, e: NewDataEvent): string | null {
  if (rules.folders.length) for (const f of foldersOf(e)) for (const dir of rules.folders) if (under(f, dir)) return `folder ${dir}`;
  const d = e.data as Record<string, unknown> | null;
  if (rules.hosts.length && typeof d?.url === "string") {
    let host = "";
    try {
      host = new URL(d.url).host.toLowerCase();
    } catch {}
    for (const h of rules.hosts) if (host === h || host.endsWith(`.${h}`)) return `host ${h}`;
  }
  if (rules.commands.length && e.type === "command") {
    const c = typeof d?.command === "string" ? d.command : (e.text ?? "");
    for (const re of rules.commands) if (re.test(c)) return `command ${re.source}`;
  }
  return null;
}
