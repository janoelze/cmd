import { describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { DATA_FLAGS, DEFAULT_SETTINGS, HOOK_FORMAT, type Settings } from "@cmd/protocol";
import { DataService } from "../src/data/service.ts";
import { ActivityLog } from "../src/agents/activity/log.ts";
import { JournalStore } from "../src/journal/store.ts";

const service = (over: Partial<Settings> = {}, now = () => 1_800_000_000_000) => new DataService({ file: null, recordedBy: "test", settings: () => ({ ...DEFAULT_SETTINGS, ...over }), now });

describe("DataService", () => {
  it("records with redaction, marks what it changed, notes the entities", () => {
    const d = service();
    const e = d.record({ id: "c1", at: 1, type: "command", source: "osc", paneId: "p1", spaceId: "s1", text: "export TOKEN=abcdefghijklmnop", data: { command: "export TOKEN=abcdefghijklmnop", exitCode: 0, cwd: "/w", output: null } })!;
    expect(e.text).toBe("export TOKEN=[redacted]");
    expect((e.data as { command: string }).command).toContain("[redacted]");
    expect(e.flags & DATA_FLAGS.redacted).toBeTruthy();
    expect(d.store.entities("pane").map((x) => x.id)).toEqual(["p1"]);
    expect(d.store.entities("space").map((x) => x.id)).toEqual(["s1"]);
    const clean = d.record({ id: "c2", at: 2, type: "command", source: "osc", text: "ls", data: { command: "ls", exitCode: 0, cwd: "/w", output: null } })!;
    expect(clean.flags & DATA_FLAGS.redacted).toBeFalsy();
  });

  it("cuts content at the class's cap and says so", () => {
    const d = service();
    const e = d.record({ id: "c1", at: 1, type: "command", source: "osc", data: { command: "yes", exitCode: 0, cwd: "/", output: { chars: 300_000, cut: false } }, content: "y\n".repeat(150_000) })!;
    expect(e.flags & DATA_FLAGS.cut).toBeTruthy();
    expect(d.store.blob(e.blob!)!.length).toBe(256_000);
  });

  it("records nothing of a class that's switched off", () => {
    const d = service({ "data.record.output": false, "data.record.actions": false } as Partial<Settings>);
    expect(d.record({ id: "c", at: 1, type: "command", source: "osc", data: { command: "ls", exitCode: 0, cwd: "/", output: null } })).toBeNull();
    expect(d.record({ id: "u", at: 1, type: "user.look", source: "user", data: { agentId: "a" } })).toBeNull();
    expect(d.record({ id: "g", at: 1, type: "git.tag", source: "git", data: { tag: "v1", hash: "h", repo: "/r" } })).not.toBeNull();
    expect(d.explain().find((c) => c.class === "output")!.enabled).toBe(false);
  });

  it("prunes by class: output after 90 days, git never, the rest after data.keepDays", () => {
    const now = 1_800_000_000_000;
    const day = 86400_000;
    const d = service({ "data.keepDays": 10 } as Partial<Settings>, () => now);
    d.record({ id: "old-cmd", at: now - 91 * day, type: "command", source: "osc", data: { command: "ls", exitCode: 0, cwd: "/", output: null } });
    d.record({ id: "new-cmd", at: now - 89 * day, type: "command", source: "osc", data: { command: "ls", exitCode: 0, cwd: "/", output: null } });
    d.record({ id: "old-git", at: now - 400 * day, type: "git.tag", source: "git", data: { tag: "v1", hash: "h", repo: "/r" } });
    d.record({ id: "old-look", at: now - 11 * day, type: "user.look", source: "user", data: { agentId: "a" } });
    d.record({ id: "new-look", at: now - 9 * day, type: "user.look", source: "user", data: { agentId: "a" } });
    const r = d.prune();
    expect(r.events).toBe(2);
    expect(d.query({}).map((e) => e.id).sort()).toEqual(["data:prune:1800000000000", "new-cmd", "new-look", "old-git"]);
  });

  it("imports what an older cmd kept, once", () => {
    const legacy = new DatabaseSync(":memory:");
    const activity = new ActivityLog(legacy, { recordedBy: "0.14.4" });
    activity.insert({ at: 1000, agent: "claude", name: "UserPromptSubmit", payload: { hook_event_name: "UserPromptSubmit", session_id: "s", prompt: "fix the flaky test", cwd: "/w" }, hook: HOOK_FORMAT }, "p", "a");
    activity.insert({ at: 2000, agent: "claude", name: "PreToolUse", payload: { hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t1", tool_input: { command: "pnpm test" } }, hook: HOOK_FORMAT }, "p", "a");
    activity.insert({ at: 3000, agent: "claude", name: "PostToolUse", payload: { hook_event_name: "PostToolUse", session_id: "s", tool_name: "Bash", tool_use_id: "t1", tool_response: "ok" }, hook: HOOK_FORMAT }, "p", "a");
    const journal = new JournalStore(legacy);
    journal.record({ at: 4000, until: 4100, kind: "command", key: "command:x", spaceId: null, repo: null, cwd: "/w", thread: "pane:p", text: "pnpm test", data: { kind: "command", command: "pnpm test", exitCode: 0, paneId: "p" } });
    journal.record({ at: 5000, until: null, kind: "agent.session", key: "session:s", spaceId: null, repo: null, cwd: "/w", thread: "session:s", text: "derived", data: { kind: "agent.session", agent: "claude", sessionId: "s", title: null, firstPrompt: null, branch: null } });
    const d = service();
    expect(d.importLegacy(legacy)).toEqual({ hooks: 3, journal: 1 });
    expect(d.importLegacy(legacy)).toBeNull();
    const hooks = d.query({ types: ["agent.hook"] });
    expect(hooks.length).toBe(3);
    expect(hooks[0]!.text).toBe("fix the flaky test");
    expect(hooks[0]!.sessionId).toBe("claude:s");
    expect(hooks[2]!.parentId).toBe(hooks[1]!.id);
    expect(hooks.every((e) => e.flags & DATA_FLAGS.imported)).toBe(true);
    expect(d.query({ types: ["command"] })[0]!.text).toBe("pnpm test");
    expect(d.query({ text: "flaky" }).length).toBe(1);
    expect(d.query({ types: ["data.op"] }).length).toBe(1);
  });
});
