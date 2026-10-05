import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ACTIVITY_SCHEMA, DEFAULT_SETTINGS, EXPORT_FORMAT, HOOK_FORMAT, TURN_FORMAT, type ActivityEvent } from "@cmd/protocol";
import { FIXTURE_EPOCH, fixtureMeta, readFixture, toFixture } from "../src/agents/activity/fixture.ts";
import { agentVersion } from "../src/agents/procinfo.ts";
import { Core } from "../src/core.ts";
import { changedBetween, snapshot } from "../src/agents/activity/gitsnap.ts";
import { ActivityLog } from "../src/agents/activity/log.ts";
import { normalize, shellWrites, type RawEvent } from "../src/agents/activity/normalize.ts";
import { watchTurn } from "../src/agents/activity/fswatch.ts";
import { ActivityReducer, QUIET_MS, type Reduction } from "../src/agents/activity/reduce.ts";
import { drainSpool } from "../src/agents/activity/spool.ts";
import { AgentHomes } from "../src/agents/homes.ts";
import { AgentTracker } from "../src/agents/tracker.ts";
import { NotificationCenter } from "../src/notifications.ts";
import { PaneManager } from "../src/panes.ts";
import { fakeFactory, type FakePty } from "./fake-pty.ts";
import { rmTemp } from "./tmp.ts";

const FIX = path.join(import.meta.dirname, "fixtures/agents");
const fixture = (name: string) => readFixture(fs.readFileSync(path.join(FIX, name), "utf8"));

/** Replays raw events through normalize + a fresh reducer; returns every reduction. */
function replay(raws: RawEvent[]) {
  const red = new ActivityReducer("a1");
  const out: { ev: ActivityEvent; r: Reduction }[] = [];
  raws.forEach((raw, i) => {
    const ev = normalize(raw, i + 1);
    out.push({ ev, r: red.apply(ev) });
  });
  return { red, out, states: out.map((o) => o.r.change.state).filter(Boolean) };
}

let dir: string;
beforeEach(() => {
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "cmd-activity-")));
});
afterEach(() => rmTemp(dir));

describe("normalize (Claude Code 2.1.289, recorded)", () => {
  it("maps hook events to one vocabulary, with tools, paths and the config dir", () => {
    const evs = fixture("claude-2.1.289/edit-and-bash.jsonl").map((r, i) => normalize(r, i));
    expect(evs.map((e) => e.kind)).toEqual(["session.start", "prompt", "tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "stop", "session.end"]);
    const edit = evs.find((e) => e.kind === "tool.end" && e.tool?.name === "Edit")!;
    expect(edit.tool).toMatchObject({ label: "Editing calc.py", paths: ["/work/repo/calc.py"], ok: true });
    expect(edit.tool!.id).toMatch(/^toolu_/);
    expect(evs.filter((e) => e.tool?.name === "Bash").map((e) => e.tool!.command)).toContain("python3 -c 'import calc; print(calc.add(2,3))'");
    expect(evs[0]).toMatchObject({ home: "/Users/me/.claude-profiles/work", cwd: "/work/repo", sessionId: expect.any(String), transcriptPath: expect.stringMatching(/\.jsonl$/) });
    expect(evs[1]!.turnId).toBeTruthy();
    expect(evs.at(-2)!.text).toMatch(/returns 5/);
  });

  it("reads a permission request without a message as the tool and its input", () => {
    const ask = fixture("claude-2.1.289/permission-denied.jsonl").map((r) => normalize(r)).find((e) => e.kind === "ask")!;
    expect(ask).toMatchObject({ text: "Allow Bash?", tool: { name: "Bash", command: "rm NOTES.md" } });
  });

  it("marks prompts the agent sent itself and work left running at a stop", () => {
    const evs = fixture("claude-2.1.289/background-subagent.jsonl").map((r) => normalize(r));
    const [first, second] = evs.filter((e) => e.kind === "stop");
    expect(first!.background).toEqual(["Find what add() function returns in calc.py"]);
    expect(second!.background).toBeUndefined();
    expect(evs.filter((e) => e.kind === "prompt").map((e) => !!e.auto)).toEqual([false, true]);
    expect(evs.filter((e) => e.subagent).map((e) => e.kind)).toEqual(["subagent.start", "tool.start", "tool.end", "tool.start", "tool.end", "subagent.stop"]);
  });

  it("labels shell commands that write files, without claiming which", () => {
    const writes: [string, string][] = [
      ["python3 - <<'EOF'\np='src/x.ts'; s=open(p).read(); open(p,'w').write(s.replace('a','b'))\nEOF", "script"],
      ["node -e \"require('fs').writeFileSync('a.json', '{}')\"", "script"],
      ["sed -i '' 's/a/b/' file.txt", "sed -i"],
      ["perl -pi -e 's/a/b/' f", "sed -i"],
      ["cat <<EOF > notes.md\nhi\nEOF", "redirect"],
      ["echo 'fixed add' >> /work/repo/NOTES.md", "redirect"],
      ["make 2>&1 | tee build.log", "tee"],
      ["cd x && rm -rf dist", "file command"],
      ["git checkout -- src/a.ts", "git"],
      ["npx prettier --write src", "formatter"],
      ["curl -sL -o out.zip https://x", "download"],
      ["pnpm install", "install"],
    ];
    for (const [cmd, kind] of writes) expect([cmd, shellWrites(cmd)]).toEqual([cmd, kind]);
    const reads = ["ls -la src", "grep -rn 'x > y' src", "git status --short", "cat a.txt 2>/dev/null", "npm test 2>&1 | tail -5", "python3 -c 'import calc; print(calc.add(2,3))'", "node -e 'console.log(a => a > 1)'", "find . -name '*.ts' > /dev/null"];
    for (const cmd of reads) expect([cmd, shellWrites(cmd)]).toEqual([cmd, undefined]);
  });

  it("passes unknown events and tools through instead of failing", () => {
    const ev = normalize({ at: 1, agent: "claude", name: "SomethingNew", payload: { hook_event_name: "SomethingNew", session_id: "s" } });
    expect(ev).toMatchObject({ kind: "other", name: "SomethingNew", sessionId: "s" });
    const tool = normalize({ at: 1, agent: "codex", name: "PreToolUse", payload: { hook_event_name: "PreToolUse", tool_name: "apply_patch", tool_input: { input: "*** Begin Patch\n*** Update File: src/a.ts\n*** Add File: b.md\n*** End Patch" } } });
    expect(tool.tool).toMatchObject({ name: "apply_patch", paths: ["src/a.ts", "b.md"] });
  });
});

describe("real interactive use (Claude Code 2.1.289, cut from the author's sessions, text replaced)", () => {
  it("keeps prompts typed while the agent works in the same turn", () => {
    const { red, out } = replay(fixture("claude-2.1.289/interactive-followups.jsonl"));
    const closed = out.filter((o) => o.r.closed).map((o) => o.r.closed!);
    // Six prompts, two Stops: two turns, each with its follow-up, both done.
    expect(closed.map((t) => [t.index, t.outcome, t.followUps.length])).toEqual([
      [0, "done", 1],
      [1, "done", 1],
    ]);
    expect(red.turn!.inferred).toEqual([]);
  });

  it("keeps what Claude's helpers write after a Stop as notes, not subagents", () => {
    const { red, out } = replay(fixture("claude-2.1.289/helper-note.jsonl"));
    expect(out.some((o) => o.r.change.subagent)).toBe(false);
    const first = out.find((o) => o.r.closed)!.r.closed!;
    expect(first.notes).toHaveLength(1);
    expect(first.subagents).toBe(0);
    expect(red.turn!.index).toBe(1); // the next prompt came after the Stop: a new turn
  });

  it("shows what the user saw when a request fails, not the error code", () => {
    const { red } = replay(fixture("claude-2.1.289/rate-limit.jsonl"));
    expect(red.turn).toMatchObject({ outcome: "failed" });
    expect(red.turn!.error).toMatch(/^<message/); // last_assistant_message (replaced), not "rate_limit"
  });
});

describe("tracker: turns that end as another begins", () => {
  it("saves the ended turn in its final state", () => {
    const f = fakeFactory();
    const panes = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    const activity = new ActivityLog();
    const agents = new AgentTracker(panes, { activity });
    const pane = panes.create();
    const a = agents.ingestHook(pane.id, "claude", "UserPromptSubmit", { session_id: "s1", prompt: "one" })!;
    // One event ends a turn and starts the next: a prompt in a new session (no SessionStart seen in between).
    agents.ingestHook(pane.id, "claude", "UserPromptSubmit", { session_id: "s2", prompt: "two" });
    expect(activity.turns(a.id).map((t) => [t.index, t.outcome])).toEqual([
      [0, "interrupted"],
      [1, "working"],
    ]);
  });
});

describe("normalize and reduce (Codex 0.144.5, recorded)", () => {
  it("reads its patch (in tool_input.command) as file edits, not a shell command", () => {
    const evs = fixture("codex-0.144.5/edit-and-bash.jsonl").map((r, i) => normalize(r, i));
    expect(evs.map((e) => e.kind)).toEqual(["session.start", "prompt", "tool.start", "tool.end", "tool.start", "tool.end", "tool.start", "tool.end", "stop"]);
    const patch = evs.find((e) => e.kind === "tool.end" && e.tool?.name === "apply_patch")!;
    expect(patch.tool).toMatchObject({ label: "Editing calc.py", paths: ["/work/repo/calc.py"], ok: true });
    expect(patch.tool!.command).toBeUndefined();
    expect(patch.tool!.writes).toBeUndefined();
    expect(evs.filter((e) => e.kind === "tool.start" && e.tool?.name === "Bash").map((e) => e.tool!.writes)).toEqual([undefined, "redirect"]);
    expect(evs[0]).toMatchObject({ agent: "codex", home: "/Users/me/.codex-alt", sessionId: expect.any(String) });
    expect(new Set(evs.slice(1).map((e) => e.turnId)).size).toBe(1);
  });

  it("turns a session into one turn like Claude's", () => {
    const { red, states } = replay(fixture("codex-0.144.5/edit-and-bash.jsonl"));
    expect(states.at(-1)).toBe("done");
    expect(red.turn).toMatchObject({ outcome: "done", inferred: [], shellWrites: 1, files: [{ path: "/work/repo/calc.py", via: ["tool"] }], final: expect.stringMatching(/verified the result is `5`/) });
    expect(red.turn!.tools).toEqual([
      { name: "Bash", count: 2, failed: 0 },
      { name: "apply_patch", count: 1, failed: 0 },
    ]);
  });

  it("counts a call that never reported back as failed (a failed patch sends no PostToolUse)", () => {
    const { red } = replay(fixture("codex-0.144.5/failing-tools.jsonl"));
    // The shell command exited 3, but Codex's PostToolUse only carries its output: not detectable.
    expect(red.turn!.tools).toEqual([
      { name: "Bash", count: 1, failed: 0 },
      { name: "apply_patch", count: 1, failed: 1 },
    ]);
    expect(red.turn).toMatchObject({ outcome: "done", inferred: ["1 tool call never finished"], files: [] });
  });

  it("reads a failed patch's exit code when Codex does report it", () => {
    const ev = normalize({ at: 1, agent: "codex", name: "PostToolUse", payload: { hook_event_name: "PostToolUse", tool_name: "apply_patch", tool_input: { command: "*** Begin Patch\n*** Update File: a.py\n*** End Patch" }, tool_response: "Exit code: 1\nOutput:\nfailed" } });
    expect(ev.tool).toMatchObject({ ok: false, paths: ["a.py"] });
  });
});

describe("Gemini CLI 0.62.0, recorded", () => {
  it("maps its events and tool names, without counting its per-call compression checks", () => {
    const evs = fixture("gemini-0.62.0/edit-and-shell.jsonl").map((r, i) => normalize(r, i));
    expect(evs.filter((e) => e.kind === "compact")).toEqual([]);
    expect(evs.filter((e) => e.name === "PreCompress").every((e) => e.kind === "other")).toBe(true);
    expect(evs[0]).toMatchObject({ kind: "session.start", agent: "gemini", home: "/Users/me/gemini-home" });
    const edit = evs.find((e) => e.kind === "tool.end" && e.tool?.name === "replace")!;
    expect(edit.tool).toMatchObject({ label: "Editing calc.py", paths: ["calc.py"], ok: true });
    expect(evs.filter((e) => e.kind === "tool.start" && e.tool?.name === "run_shell_command").map((e) => [e.tool!.label, e.tool!.writes])).toEqual([
      ["Append 'fixed add' to NOTES.md", "redirect"],
      ["Run calc.add(2,3) to verify the fix", undefined],
    ]);
    expect(evs.find((e) => e.name === "update_topic" || e.tool?.name === "update_topic")!.tool!.label).toMatch(/^Planning: /);
    const stop = evs.find((e) => e.kind === "stop")!;
    expect(stop.text).toMatch(/^I have updated `calc.py`/); // prompt_response, trimmed
  });

  it("turns a session into one turn, files resolved against its folder", () => {
    const { red } = replay(fixture("gemini-0.62.0/edit-and-shell.jsonl"));
    expect(red.turn).toMatchObject({ outcome: "done", shellWrites: 1, files: [{ path: "/work/repo/calc.py", via: ["tool"] }] });
  });

  it("keeps a subagent's calls (inside invoke_agent) out of the parent's, and sees a failed call", () => {
    const { red } = replay(fixture("gemini-0.62.0/subagent-and-failure.jsonl"));
    const tools = Object.fromEntries(red.turn!.tools.map((t) => [t.name, [t.count, t.failed]]));
    expect(tools).toEqual({ update_topic: [2, 0], invoke_agent: [1, 0], read_file: [1, 1] });
    expect(red.turn).toMatchObject({ outcome: "done", inferred: [] });
  });
});

describe("interactive sessions in a cmd pane (installed app 0.11.0)", () => {
  it("Gemini: its permission prompts say what they ask about, and the session ends waiting on one", () => {
    const evs = fixture("gemini-0.62.0/interactive-permissions.jsonl").map((r, i) => normalize(r, i));
    expect(evs[0]!.recorded).toBeUndefined(); // fixtures carry raw events; provenance is in the header
    const asks = evs.filter((e) => e.kind === "ask");
    expect(asks.map((e) => [e.tool?.label, e.tool?.command ?? e.tool?.paths?.[0]])).toEqual([
      ["Confirm Shell Command", "cmd ls"],
      ["Confirm Edit: calc.py", "/work/repo/calc.py"],
      ["Confirm Shell Command", "rm NOTES.md"],
      ["Confirm Edit: calc.py", "/work/repo/calc.py"],
    ]);
    const { red, out } = replay(fixture("gemini-0.62.0/interactive-permissions.jsonl"));
    expect(red.turn).toMatchObject({ outcome: "waiting", ask: { message: "Tool Confirm Edit: calc.py requires editing", tool: "edit", input: "/work/repo/calc.py" } });
    expect(out.at(-1)!.r.change.state).toBe("needs_input");
    // "continue", typed while it worked, stayed in the first turn; the declined edit ended it.
    expect(out.filter((o) => o.r.closed).map((o) => [o.r.closed!.index, o.r.closed!.outcome, o.r.closed!.followUps, o.r.closed!.inferred])).toEqual([
      [0, "interrupted", ["continue"], ["declined: a new prompt while it waited for an answer"]],
    ]);
    expect(red.turn!.index).toBe(1);
  });

  it("Codex: a real permission request (no message: the tool and its command)", () => {
    const evs = fixture("codex-0.144.5/interactive-permission.jsonl").map((r, i) => normalize(r, i));
    const ask = evs.find((e) => e.kind === "ask")!;
    expect(ask).toMatchObject({ name: "PermissionRequest", text: "Allow Bash?", tool: { name: "Bash", command: expect.stringMatching(/^cmd send /) } });
    const { red } = replay(fixture("codex-0.144.5/interactive-permission.jsonl"));
    // The first prompt was interrupted with Esc before any tool ran (no event); the second arrived while it "worked".
    expect(red.turn).toMatchObject({ index: 0, outcome: "waiting", followUps: ["Delete NOTES.md"], ask: { tool: "Bash" } });
  });

  it("Codex: a prompt typed mid-turn is a follow-up; two turns, both done", () => {
    const { out, red } = replay(fixture("codex-0.144.5/interactive-followup.jsonl"));
    expect(out.filter((o) => o.r.closed).map((o) => [o.r.closed!.index, o.r.closed!.outcome, o.r.closed!.followUps])).toEqual([
      [0, "done", ["comtinue"]],
      [1, "done", []],
    ]);
    expect(red.turn!.tools.find((t) => t.name === "Bash")).toMatchObject({ count: 1 });
  });
});

describe("lab sessions (driven in a development core's panes, scripted prompts)", () => {
  it("Claude: approvals, a reminder, background shells, an auto turn, a follow-up, /clear", () => {
    const evs = fixture("claude-2.1.289/lab-permissions-interrupts.jsonl").map((r, i) => normalize(r, i));
    // A PermissionRequest, then Claude's own reminder a few seconds later when it isn't answered.
    const asks = evs.filter((e) => e.kind === "ask");
    expect(asks.some((e) => e.name === "Notification" && e.text === "Claude needs your permission")).toBe(true);
    expect(evs.some((e) => e.kind === "stop" && e.background?.length)).toBe(true);
    expect(evs.some((e) => e.kind === "prompt" && e.auto)).toBe(true);
    const { out } = replay(fixture("claude-2.1.289/lab-permissions-interrupts.jsonl"));
    const turns = out.filter((o) => o.r.closed).map((o) => o.r.closed!);
    expect(turns.some((t) => t.outcome === "done" && t.followUps.length === 1 && t.files.some((f) => f.path.endsWith("tests.py")))).toBe(true);
    expect(turns.find((t) => t.ask?.input === "python3 slow.py")!.ask!.tool).toBe("Bash");
  });

  it("Codex: every approval is a PermissionRequest; nothing comes for an approval or a denial", () => {
    const evs = fixture("codex-0.144.5/lab-approvals.jsonl").map((r, i) => normalize(r, i));
    const asks = evs.filter((e) => e.kind === "ask");
    expect(asks.length).toBeGreaterThanOrEqual(5);
    expect(asks.every((e) => e.name === "PermissionRequest" && e.tool)).toBe(true);
    expect(asks.map((e) => e.tool!.name)).toContain("apply_patch");
    // Every question is followed by its tool's end, or by nothing (denied, interrupted): no answer event exists.
    expect(evs.some((e) => e.name.toLowerCase().includes("permission") && e.kind !== "ask")).toBe(false);
  });
});

describe("Codex resume, recorded", () => {
  it("keeps one session across exec resume, a turn each", () => {
    const evs = fixture("codex-0.144.5/two-turns-resume.jsonl").map((r, i) => normalize(r, i));
    expect(new Set(evs.map((e) => e.sessionId)).size).toBe(1);
    const { out, red } = replay(fixture("codex-0.144.5/two-turns-resume.jsonl"));
    expect(out.filter((o) => o.r.closed).map((o) => [o.r.closed!.index, o.r.closed!.outcome])).toEqual([
      [0, "done"],
      [1, "done"],
    ]);
    expect(red.turn!.inferred).toEqual([]);
  });
});

describe("reduce", () => {
  it("turns a session into state and one turn, from what the agent said", () => {
    const { red, states, out } = replay(fixture("claude-2.1.289/edit-and-bash.jsonl"));
    expect(states).toEqual(["idle", "working", "working", "working", "working", "working", "working", "working", "working", "working", "done"]);
    const t = red.turn!;
    expect(t).toMatchObject({ index: 0, outcome: "done", auto: false, inferred: [], subagents: 0 });
    expect(t.prompt).toMatch(/^calc\.py has a bug/);
    expect(t.final).toMatch(/returns 5/);
    expect(t.tools).toEqual(expect.arrayContaining([{ name: "Edit", count: 1, failed: 0 }]));
    // Edit went through a tool; the NOTES.md edit through Bash is git's to find.
    expect(t.files).toEqual([{ path: "/work/repo/calc.py", change: "M", via: ["tool"] }]);
    expect(t.shellWrites).toBe(1); // echo >> NOTES.md
    expect(out.find((o) => o.ev.kind === "stop")!.r.change).toMatchObject({ state: "done", lastMessage: t.final });
    expect(out.find((o) => o.ev.kind === "stop")!.r.cause).toBe("hook Stop");
  });

  it("records what a waiting agent asked for", () => {
    const { red, states } = replay(fixture("claude-2.1.289/permission-denied.jsonl"));
    expect(states).toEqual(["idle", "working", "working", "needs_input", "done"]);
    expect(red.turn).toMatchObject({ outcome: "done", ask: { message: "Allow Bash?", tool: "Bash", input: "rm NOTES.md" }, inferred: ["1 tool call never finished"] });
    expect(red.turn!.tools).toEqual([{ name: "Bash", count: 1, failed: 1 }]); // denied
  });

  it("keeps a subagent's calls out of its parent's state and follows the turn its result starts", () => {
    const { red, out } = replay(fixture("claude-2.1.289/background-subagent.jsonl"));
    // While the subagent works after the parent's Stop, the parent stays done.
    const afterStop = out.slice(out.findIndex((o) => o.ev.kind === "stop") + 1, out.findIndex((o) => o.ev.kind === "subagent.stop"));
    expect(afterStop.map((o) => o.r.change.state).filter(Boolean)).toEqual([]);
    expect(out.filter((o) => o.r.change.subagent).map((o) => o.r.change.subagent!.op)).toEqual(["start", "stop"]);
    expect(out.filter((o) => o.r.closed).map((o) => [o.r.closed!.index, o.r.closed!.auto, o.r.closed!.background.length])).toEqual([
      [0, false, 1],
      [1, true, 0],
    ]);
    expect(red.turn).toMatchObject({ index: 1, outcome: "done", final: expect.stringMatching(/subtraction/) });
  });

  const ev = (kind: ActivityEvent["kind"], at: number, extra: Partial<ActivityEvent> = {}): ActivityEvent => ({ id: at, at, agentId: null, paneId: null, agent: "claude", source: "hook", name: kind, kind, sessionId: "s1", ...extra });

  it("ends a turn that went quiet without a Stop (an interrupt), and takes it back if the agent goes on", () => {
    const red = new ActivityReducer("a1");
    red.apply(ev("prompt", 1000, { text: "do it" }));
    red.apply(ev("tool.start", 2000, { tool: { name: "Read", id: "t1", label: "Reading x" } }));
    red.apply(ev("tool.end", 3000, { tool: { name: "Read", id: "t1", label: "Reading x", ok: true } }));
    expect(red.tick(3000 + QUIET_MS - 1, 3000)).toBeNull();
    expect(red.tick(3000 + QUIET_MS, 3500)).toBeNull(); // output kept going: still working
    const r = red.tick(4000 + QUIET_MS, 4000)!;
    expect(r.change).toMatchObject({ state: "idle" });
    expect(r.cause).toMatch(/^inferred/);
    expect(red.turn).toMatchObject({ outcome: "interrupted", endedAt: 4000, inferred: [expect.stringMatching(/^quiet/)] });
    // It wasn't: a late Stop reopens and finishes the same turn.
    red.apply(ev("stop", 50_000, { text: "done after all" }));
    expect(red.turn).toMatchObject({ index: 0, outcome: "done", final: "done after all", inferred: [] });
  });

  it("waits longer while a tool runs; a question that's still up keeps waiting, a dismissed one ends the turn", () => {
    const red = new ActivityReducer("a1");
    red.apply(ev("prompt", 0));
    red.apply(ev("tool.start", 0, { tool: { name: "Bash", id: "t", label: "npm test" } }));
    expect(red.tick(QUIET_MS + 1, 0)).toBeNull();
    red.apply(ev("ask", 1000, { text: "Allow?" }));
    // The dialog sits there: no output after it, however long.
    expect(red.tick(10 * 60_000, 1000)).toBeNull();
    // The user pressed Esc: the agent redrew (output after the question), then went quiet.
    expect(red.tick(16_000, 1200)).toBeNull();
    expect(red.tick(20_000, 15_000)).toBeNull();
    const r = red.tick(15_000 + QUIET_MS, 15_000)!;
    expect(r.change.state).toBe("idle");
    expect(red.turn).toMatchObject({ outcome: "interrupted", inferred: [expect.stringMatching(/^declined: the screen changed/)] });
  });

  it("takes a question as answered when the terminal stays busy after it (agents send nothing for an approval)", () => {
    const red = new ActivityReducer("a1");
    red.apply(ev("prompt", 0));
    red.apply(ev("tool.start", 500, { tool: { name: "Bash", id: "t", label: "python3 slow.py", command: "python3 slow.py" } }));
    red.apply(ev("ask", 1000, { text: "Allow Bash?", tool: { name: "Bash", label: "python3 slow.py", command: "python3 slow.py" } }));
    // A redraw right after the question proves nothing.
    expect(red.tick(3000, 2000)).toBeNull();
    // Output still coming 3 s and more after it: the command runs.
    const r = red.tick(6000, 5500)!;
    expect(r.change).toMatchObject({ state: "working", detail: "python3 slow.py" });
    expect(r.cause).toBe("inferred: question answered");
    expect(red.turn).toMatchObject({ outcome: "working", inferred: [] });
    // The reminder that follows a question doesn't replace it.
    red.apply(ev("ask", 7000, { text: "Allow Bash?", tool: { name: "Bash", label: "x", command: "rm x" } }));
    red.apply(ev("ask", 9000, { text: "Claude needs your permission" }));
    expect(red.turn!.ask).toMatchObject({ tool: "Bash", input: "rm x" });
  });

  it("takes a prompt sent while the agent works as a follow-up in the same turn; a new session ends it", () => {
    const red = new ActivityReducer("a1");
    red.apply(ev("prompt", 0, { text: "one" }));
    red.apply(ev("tool.start", 5, { tool: { name: "Read", id: "t", label: "Reading x" } }));
    const r = red.apply(ev("prompt", 10, { text: "two" }));
    expect(r.closed).toBeUndefined();
    expect(r.lastPrompt).toBe("two");
    expect(red.turn).toMatchObject({ index: 0, outcome: "working", prompt: "one", followUps: ["two"] });
    const r2 = red.apply(ev("session.start", 20, { sessionId: "s2" }));
    expect(r2.closed).toMatchObject({ index: 0, outcome: "interrupted", inferred: ["new session before the turn ended"] });
    expect(red.sessionId).toBe("s2");
  });

  it("ends a turn whose question was dismissed: a prompt while it waits for an answer", () => {
    const red = new ActivityReducer("a1");
    red.apply(ev("prompt", 0, { text: "one" }));
    red.apply(ev("ask", 5, { text: "Allow?" }));
    const r = red.apply(ev("prompt", 10, { text: "two" }));
    expect(r.closed).toMatchObject({ index: 0, outcome: "interrupted", inferred: ["declined: a new prompt while it waited for an answer"] });
    expect(red.turn).toMatchObject({ index: 1, prompt: "two", followUps: [] });
  });

  it("keeps a turn going across a compaction in the same session", () => {
    const red = new ActivityReducer("a1");
    red.apply(ev("prompt", 0));
    expect(red.apply(ev("session.start", 5)).change.state).toBeUndefined(); // Claude's SessionStart(source: compact)
    expect(red.open).toBe(true);
  });
});

describe("spool", () => {
  it("drains a pane's events oldest first and removes them, skipping files still being written", () => {
    const log = path.join(dir, "p1", "log");
    fs.mkdirSync(log, { recursive: true });
    const write = (name: string, event: object, t: number) => {
      const f = path.join(log, name);
      fs.writeFileSync(f, JSON.stringify({ agent: "claude", ts: 1, env: { CLAUDE_CONFIG_DIR: "/c" }, event }));
      fs.utimesSync(f, t, t);
    };
    write("1.2.Stop.json", { hook_event_name: "Stop" }, 200);
    write("1.1.UserPromptSubmit.json", { hook_event_name: "UserPromptSubmit", prompt: "x" }, 100);
    fs.writeFileSync(path.join(log, ".Stop.99"), "{");
    fs.writeFileSync(path.join(log, "1.3.Bad.json"), "not json");
    const { events, bad } = drainSpool(dir, "p1");
    expect(events.map((e) => e.name)).toEqual(["UserPromptSubmit", "Stop"]);
    expect(events[0]).toMatchObject({ agent: "claude", env: { CLAUDE_CONFIG_DIR: "/c" }, at: 100_000 });
    expect(bad).toEqual(["1.3.Bad.json"]);
    expect(fs.readdirSync(log)).toEqual([".Stop.99"]);
  });
});

describe("tracker: spooled events", () => {
  let panes: PaneManager;
  let agents: AgentTracker;
  let ptys: FakePty[];
  let activity: ActivityLog;
  const root = () => path.join(dir, "status");

  /** Writes recorded events into a pane's spool as cmd's hook would. */
  function spool(paneId: string, raws: RawEvent[]) {
    const log = path.join(root(), paneId, "log");
    fs.mkdirSync(log, { recursive: true });
    for (const [i, r] of raws.entries()) {
      const f = path.join(log, `${i}.${i}.${r.name}.json`);
      fs.writeFileSync(f, JSON.stringify({ agent: r.agent, ts: 0, env: r.env ?? {}, event: r.payload }));
      fs.utimesSync(f, r.at / 1000, r.at / 1000);
    }
  }

  beforeEach(() => {
    const f = fakeFactory();
    ptys = f.ptys;
    panes = new PaneManager(f.factory, { socketPath: "/tmp/t.sock", pollMs: 0 });
    activity = new ActivityLog();
    agents = new AgentTracker(panes, { statusRoot: root(), activity });
  });
  afterEach(() => agents.close());

  it("gives the agent its state, final message and turn, and the done notification its text", async () => {
    const pane = panes.create();
    const center = new NotificationCenter(panes, agents, () => ({ ...DEFAULT_SETTINGS, "notifications.done": true }));
    const sent: { title: string; body: string }[] = [];
    center.on("notification", (n) => sent.push(n));
    const homes: string[] = [];
    agents.on("home", (_a, d) => homes.push(d));
    spool(pane.id, fixture("claude-2.1.289/edit-and-bash.jsonl").slice(0, -1)); // the process is still there: no SessionEnd yet
    ptys[0]!.process = "claude";
    await panes.pollForeground();
    const a = agents.list()[0]!;
    expect(a).toMatchObject({ kind: "claude", state: "done", stateCause: "hook Stop", lastMessage: expect.stringMatching(/returns 5/), lastPrompt: expect.stringMatching(/^calc\.py has a bug/), cwd: "/work/repo" });
    expect(a.native.claudeSessionId).toBeTruthy();
    expect(a.turn).toMatchObject({ index: 0, outcome: "done", files: [{ path: "/work/repo/calc.py" }] });
    expect(activity.turns(a.id)).toHaveLength(1);
    expect(activity.events({ agentId: a.id }).map((e) => e.kind)).toContain("stop");
    expect(homes).toContain("/Users/me/.claude-profiles/work");
    expect(fs.readdirSync(path.join(root(), pane.id, "log"))).toEqual([]);
    // A replayed (claimed) stop doesn't notify, a live one does.
    spool(pane.id, [
      { at: FIXTURE_EPOCH + 100_000, agent: "claude", name: "UserPromptSubmit", payload: { hook_event_name: "UserPromptSubmit", session_id: a.native.claudeSessionId, prompt: "and again" } },
      { at: FIXTURE_EPOCH + 101_000, agent: "claude", name: "Stop", payload: { hook_event_name: "Stop", session_id: a.native.claudeSessionId, last_assistant_message: "Did it again." } },
    ]);
    agents.applyStatus(pane.id);
    expect(sent.at(-1)).toMatchObject({ body: "Did it again." });
    expect(agents.get(a.id)!.turn).toMatchObject({ index: 1, prompt: "and again" });
  });

  it("resumes turns after a core restart without counting events twice", async () => {
    const pane = panes.create();
    const raws = fixture("claude-2.1.289/background-subagent.jsonl");
    const cut = raws.findIndex((r) => r.name === "SubagentStop");
    spool(pane.id, raws.slice(0, cut));
    ptys[0]!.process = "claude";
    await panes.pollForeground();
    const a = agents.list()[0]!;
    expect(a.turn).toMatchObject({ index: 0, outcome: "done" });
    // A new core: same database, the agent comes back from the store, the rest arrives.
    agents.close();
    const again = new AgentTracker(panes, { statusRoot: root(), activity });
    again.restore(a, true);
    spool(pane.id, raws.slice(cut, -1));
    again.applyStatus(pane.id);
    expect(activity.turns(a.id).map((t) => [t.index, t.outcome, t.auto])).toEqual([
      [0, "done", false],
      [1, "done", true],
    ]);
    expect(activity.turns(a.id)[0]!.tools).toEqual([{ name: "Agent", count: 1, failed: 0 }]);
    again.close();
  });

  it("notes events that don't fit and reports what each agent's events carried", async () => {
    const pane = panes.create();
    ptys[0]!.process = "codex";
    await panes.pollForeground();
    spool(pane.id, fixture("claude-2.1.289/permission-denied.jsonl").slice(0, -1));
    agents.applyStatus(pane.id);
    const kinds = activity.events({ paneId: pane.id }).map((e) => e.kind);
    expect(kinds.filter((k) => k === "anomaly").length).toBeGreaterThan(0);
    const cov = activity.coverage(100_000).find((c) => c.agent === "claude")!;
    expect(cov).toMatchObject({ sessions: 1, kinds: { ask: 1, stop: 1 }, unmapped: [] });
    expect(cov.fields["stop.text"]).toBe(1);
    expect(cov.fields["session.start.home"]).toBe(1);
  });
});

describe("git snapshots", () => {
  const git = (...args: string[]) => execFileSync("git", ["-C", dir, "-c", "user.email=t@t", "-c", "user.name=t", ...args], { encoding: "utf8" });

  it("finds files changed during a turn however they were changed, commits included", async () => {
    git("init", "-q");
    fs.writeFileSync(path.join(dir, "a.txt"), "a\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
    fs.writeFileSync(path.join(dir, "dirty.txt"), "x\n");
    git("add", ".");
    git("commit", "-qm", "init");
    fs.writeFileSync(path.join(dir, "dirty.txt"), "already dirty before the turn\n");
    fs.writeFileSync(path.join(dir, "untouched-dirty.txt"), "untracked, before\n");
    const before = (await snapshot(dir))!;
    await new Promise((r) => setTimeout(r, 20));
    execFileSync("sed", ["-i", "", "s/a/A/", path.join(dir, "a.txt")]); // an edit through the shell
    fs.writeFileSync(path.join(dir, "new.txt"), "n\n");
    fs.mkdirSync(path.join(dir, "__pycache__"));
    fs.writeFileSync(path.join(dir, "__pycache__", "a.pyc"), "");
    fs.appendFileSync(path.join(dir, "dirty.txt"), "and again\n");
    fs.writeFileSync(path.join(dir, "b.txt"), "B\n");
    git("commit", "-qam", "during the turn"); // commits b.txt (and a.txt, dirty.txt)
    const after = (await snapshot(dir))!;
    const changed = await changedBetween(before, after);
    expect(Object.fromEntries(changed)).toEqual({
      [path.join(dir, "a.txt")]: "M",
      [path.join(dir, "b.txt")]: "M",
      [path.join(dir, "dirty.txt")]: "M",
      [path.join(dir, "new.txt")]: "A",
    });
  });

  it("is null outside a work tree", async () => {
    expect(await snapshot(dir)).toBeNull();
  });
});

describe("folder watch (outside git)", () => {
  it("collects files changed while it runs, leaving out dependencies and build output", async () => {
    fs.mkdirSync(path.join(dir, "node_modules", "x"), { recursive: true });
    fs.writeFileSync(path.join(dir, "gone.txt"), "x");
    const w = watchTurn(dir)!;
    await new Promise((r) => setTimeout(r, 200));
    fs.writeFileSync(path.join(dir, "a.txt"), "a");
    fs.mkdirSync(path.join(dir, "sub"));
    fs.writeFileSync(path.join(dir, "sub", "b.txt"), "b");
    fs.writeFileSync(path.join(dir, "node_modules", "x", "index.js"), "");
    fs.rmSync(path.join(dir, "gone.txt"));
    await new Promise((r) => setTimeout(r, 1500));
    expect(Object.fromEntries(w.stop())).toEqual({ [path.join(dir, "a.txt")]: "M", [path.join(dir, "sub", "b.txt")]: "M", [path.join(dir, "gone.txt")]: "D" });
  });

  it("won't watch a folder as broad as home", () => {
    expect(watchTurn(os.homedir())).toBeNull();
    expect(watchTurn("/")).toBeNull();
  });
});

describe("agent homes", () => {
  it("finds homes by default, env, setting and shape, and learns ones agents report", () => {
    const home = path.join(dir, "home");
    const mk = (...p: string[]) => fs.mkdirSync(path.join(home, ...p), { recursive: true });
    mk(".claude", "projects");
    mk(".claude-profiles", "work", "projects");
    fs.writeFileSync(path.join(home, ".claude-profiles", "work", ".claude.json"), "{}");
    mk(".claude-profiles", "half", "projects"); // no config files: not a home
    mk("src", "repo", ".claude"); // a project's .claude folder: not a home
    fs.writeFileSync(path.join(home, "src", "repo", ".claude", "settings.json"), "{}");
    mk("dotfiles", "codex-home", "sessions");
    mk("elsewhere", "claude", "projects");
    fs.writeFileSync(path.join(home, "elsewhere", "claude", "settings.json"), "{}");
    mk("deep", "down", "cfg", "projects");
    fs.writeFileSync(path.join(home, "deep", "down", "cfg", "history.jsonl"), "");
    const homes = new AgentHomes(null, () => ({ home, env: { CLAUDE_CONFIG_DIR: path.join(home, "elsewhere", "claude") } }), () => ["~/dotfiles/codex-home"]);
    homes.discover();
    const rel = (d: string) => path.relative(home, d);
    expect(homes.all().map((h) => [h.agent, rel(h.dir), h.via.join(","), h.env])).toEqual([
      ["claude", ".claude", "default", null], // a default dir counts even before it looks like a home
      ["claude", "elsewhere/claude", "env", { CLAUDE_CONFIG_DIR: path.join(home, "elsewhere", "claude") }],
      ["claude", ".claude-profiles/work", "scan", { CLAUDE_CONFIG_DIR: path.join(home, ".claude-profiles", "work") }],
      ["codex", "dotfiles/codex-home", "setting", { CODEX_HOME: path.join(home, "dotfiles", "codex-home") }],
    ]);
    // Too deep for the scan, but a running agent reports it.
    const cfg = path.join(home, "deep", "down", "cfg");
    expect(homes.learn("claude", cfg, "hook")).toMatchObject({ dir: cfg, via: ["hook"] });
    expect(homes.learn("claude", cfg, "hook")).toBeNull();
    expect(homes.homeOfTranscript("claude", path.join(cfg, "projects", "-x", "s.jsonl"))).toBe(cfg);
  });

  it("keeps what it found across restarts and forgets homes that are gone", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    const home = path.join(dir, "home");
    fs.mkdirSync(path.join(home, "x", "projects"), { recursive: true });
    fs.writeFileSync(path.join(home, "x", ".claude.json"), "{}");
    const ctx = () => ({ home: path.join(dir, "elsewhere"), env: {} });
    new AgentHomes(db, ctx).learn("claude", path.join(home, "x"), "hook");
    expect(new AgentHomes(db, ctx).all().map((h) => h.dir)).toEqual([path.join(home, "x")]);
    rmTemp(path.join(home, "x"));
    expect(new AgentHomes(db, ctx).all()).toEqual([]);
  });
});

describe("fixtures", () => {
  it("round-trip with paths rewritten", () => {
    const raws: RawEvent[] = [
      { at: 5000, agent: "claude", name: "Stop", payload: { cwd: "/Users/someone/src/x", last_assistant_message: "edited /Users/someone/src/x/a.ts" } },
      { at: 5250, agent: "claude", name: "SessionEnd", payload: {}, env: { CLAUDE_CONFIG_DIR: "/Users/someone/.claude" } },
    ];
    const text = toFixture(raws, { "/Users/someone/src/x": "/work/repo", "/Users/someone": "/Users/me" });
    expect(text).not.toContain("someone");
    const back = readFixture(text);
    expect(back.map((r) => r.at - FIXTURE_EPOCH)).toEqual([0, 250]);
    expect(back[0]!.payload).toEqual({ cwd: "/work/repo", last_assistant_message: "edited /work/repo/a.ts" });
    expect(back[1]!.env).toEqual({ CLAUDE_CONFIG_DIR: "/Users/me/.claude" });
  });
});

describe("versions and provenance", () => {
  it("adds missing columns to an older database and reads its rows as schema 1", async () => {
    const { DatabaseSync } = await import("node:sqlite");
    const db = new DatabaseSync(":memory:");
    // The shape development builds of 2026-10-05 created.
    db.exec(`CREATE TABLE agent_events (id INTEGER PRIMARY KEY AUTOINCREMENT, at REAL NOT NULL, pane_id TEXT, agent_id TEXT, agent TEXT, source TEXT NOT NULL, name TEXT NOT NULL, doc TEXT NOT NULL, env TEXT);
             CREATE TABLE agent_turns (agent_id TEXT NOT NULL, idx INTEGER NOT NULL, started_at REAL NOT NULL, doc TEXT NOT NULL, PRIMARY KEY (agent_id, idx));`);
    db.prepare(`INSERT INTO agent_events (at, pane_id, agent_id, agent, source, name, doc) VALUES (1, 'p', 'a', 'claude', 'hook', 'Stop', '{"hook_event_name":"Stop","last_assistant_message":"old"}')`).run();
    const log = new ActivityLog(db, { recordedBy: "0.11.0" });
    expect(log.schemaVersion()).toBe(ACTIVITY_SCHEMA);
    const [old] = log.events({ agentId: "a" });
    expect(old).toMatchObject({ kind: "stop", text: "old", recorded: { schema: 1, cmd: null, hook: null } });
    const ev = log.insert({ at: 2, agent: "claude", name: "Stop", payload: { hook_event_name: "Stop", session_id: "s" }, hook: HOOK_FORMAT }, "p", "a", "2.1.289");
    expect(ev).toMatchObject({ agentVersion: "2.1.289", recorded: { schema: ACTIVITY_SCHEMA, cmd: "0.11.0", hook: HOOK_FORMAT } });
    expect(log.events({ agentId: "a" }).at(-1)).toMatchObject({ agentVersion: "2.1.289", recorded: { cmd: "0.11.0", hook: HOOK_FORMAT } });
    // Opening it again changes nothing.
    expect(() => new ActivityLog(db)).not.toThrow();
  });

  it("gives every turn its format, its agent and who derived it", () => {
    const red = new ActivityReducer("a1", 0, { agentKind: "claude", agentVersion: "2.1.289", derivedBy: "0.11.0" });
    for (const [i, raw] of fixture("claude-2.1.289/edit-and-bash.jsonl").entries()) red.apply(normalize(raw, i));
    expect(red.turn).toMatchObject({ format: TURN_FORMAT, derivedBy: "0.11.0", agentKind: "claude", agentVersion: "2.1.289", model: null }); // claude -p sends no model (interactive sessions do)
    const codex = new ActivityReducer("a2", 0, { agentKind: "codex" });
    for (const [i, raw] of fixture("codex-0.144.5/edit-and-bash.jsonl").entries()) codex.apply(normalize(raw, i));
    expect(codex.turn).toMatchObject({ agentKind: "codex", agentVersion: null, model: "gpt-5.6-sol" });
  });

  it("reads fixture headers and skips them when replaying", () => {
    const text = fs.readFileSync(path.join(FIX, "codex-0.144.5/failing-tools.jsonl"), "utf8");
    expect(fixtureMeta(text)).toMatchObject({ fixture: 1, agent: "codex", agentVersion: "0.144.5", hook: 2 });
    expect(readFixture(text)[0]!.name).toBe("SessionStart");
    const written = toFixture([{ at: 0, agent: "claude", name: "Stop", payload: {}, hook: 2 }], {}, { agent: "claude", agentVersion: "9.9.9", recordedBy: "0.11.0", hook: 2 });
    expect(fixtureMeta(written)).toMatchObject({ agentVersion: "9.9.9" });
    expect(readFixture(written)).toEqual([{ at: FIXTURE_EPOCH, agent: "claude", name: "Stop", payload: {}, hook: 2 }]);
  });

  it("reads the hook record format from spool files", () => {
    const log = path.join(dir, "p2", "log");
    fs.mkdirSync(log, { recursive: true });
    fs.writeFileSync(path.join(log, "1.1.Stop.json"), JSON.stringify({ v: 3, agent: "claude", event: { hook_event_name: "Stop" } }));
    fs.writeFileSync(path.join(log, "1.2.Stop.json"), JSON.stringify({ agent: "claude", event: { hook_event_name: "Stop" } }));
    expect(drainSpool(dir, "p2").events.map((e) => e.hook).sort()).toEqual([2, 3]);
  });

  it("finds an agent's version in its executable's path or its package.json", () => {
    const v = path.join(dir, "share", "claude", "versions", "2.3.4");
    fs.mkdirSync(path.join(dir, "bin"), { recursive: true });
    fs.mkdirSync(path.dirname(v), { recursive: true });
    fs.writeFileSync(v, "");
    fs.symlinkSync(v, path.join(dir, "bin", "claude"));
    expect(agentVersion({ path: "/bin/bash", argv: ["bash", "/x/safehouse", path.join(dir, "bin", "claude")] }, "claude")).toBe("2.3.4");
    const pkg = path.join(dir, "lib", "node_modules", "@openai", "codex");
    fs.mkdirSync(path.join(pkg, "bin"), { recursive: true });
    fs.writeFileSync(path.join(pkg, "package.json"), JSON.stringify({ name: "@openai/codex", version: "0.150.0" }));
    fs.writeFileSync(path.join(pkg, "bin", "codex.js"), "");
    expect(agentVersion({ path: "/usr/local/bin/node", argv: ["node", path.join(pkg, "bin", "codex.js")] }, "codex")).toBe("0.150.0");
    expect(agentVersion({ path: "/usr/bin/vim", argv: ["vim"] }, "claude")).toBeNull();
  });
});

describe("export", () => {
  it("pages through everything with a versioned header, home folders anonymized on request", async () => {
    const core = new Core({ socketPath: path.join(dir, "c.sock"), dbPath: null, terminals: fakeFactory().factory, pollMs: 0, build: "abcdef1234567890" });
    try {
      const pane = core.panes.create();
      for (const raw of fixture("claude-2.1.289/edit-and-bash.jsonl").slice(0, -1)) core.agents.ingestHook(pane.id, "claude", raw.name, { ...raw.payload, cwd: path.join(os.homedir(), "src", "x") });
      const first = await core.call("agents.export", { limit: 4, anonymize: true });
      expect(first.header).toMatchObject({ format: "cmd-agent-activity", version: EXPORT_FORMAT, schema: ACTIVITY_SCHEMA, turnFormat: TURN_FORMAT, cmd: "source+abcdef12", anonymized: true });
      expect(first.turns).toHaveLength(1);
      expect(first.turns[0]).toMatchObject({ format: TURN_FORMAT, derivedBy: "source+abcdef12", agentKind: "claude" });
      expect(first.events).toHaveLength(4);
      expect(JSON.stringify(first)).not.toContain(os.homedir());
      expect(first.events[0]!.cwd).toBe("~/src/x");
      expect(first.events[0]!.raw).toBeDefined();
      let all = first.events.length;
      for (let next = first.next; next !== null; ) {
        const page = await core.call("agents.export", { limit: 4, afterId: next });
        expect(page.turns).toEqual([]);
        all += page.events.length;
        next = page.next;
      }
      expect(all).toBe(11);
    } finally {
      await core.close();
    }
  });
});
