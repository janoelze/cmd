// Usage Stats against the fake host (@cmd/widget-api/testing): the native Stats window's job. The
// page in this workspace (its sentence, numbers with their change, a pane per area) and with every
// workspace from the title menu (active time, projects, cmd's model calls); the range, kept per
// window; a number opens its detail, split by a dimension, and Back; nothing counted yet; loading;
// refused (no stat can be read: the page says why, Try Again asks again) and one stat refused (its
// pane left out); many commands ranked; asked again a moment after a command is recorded.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import type { StatQuery, StatResult } from "@cmd/widget-api";
import UsageStats, { SETTLE_MS, change, delta, duration, sentence, value } from "./stats.tsx";

const { stat, command } = fixtures;
const H = 3_600_000;

/** A host answering every stat: agent time by agent, turns by outcome, commands ranked; `over` per stat id. */
function answers(over: Record<string, (q: StatQuery) => StatResult> = {}) {
  return (q: StatQuery): StatResult => {
    if (over[q.stat]) return over[q.stat]!(q);
    const unit = q.stat === "agents.time" || q.stat === "agents.waiting" || q.stat === "you.active" ? "ms" : q.stat === "commands.failrate" ? "percent" : q.stat === "agents.tokens" ? "tokens" : "count";
    const series = q.by === "agent" ? [{ key: "claude", label: "Claude", values: [H, 2 * H, 0, H, 3 * H, H, 2 * H] }, { key: "codex", label: "Codex", values: [0, H, 0, 0, H, 0, 0] }] : q.by === "outcome" ? [{ key: "done", label: "Done", values: [3, 4, 1, 2, 5, 2, 3] }, { key: "stopped", label: "Stopped", values: [0, 1, 0, 0, 1, 0, 1] }] : undefined;
    const r = stat(q, { unit, title: q.stat, ...(series ? { series } : { values: unit === "ms" ? [H, H, H, H, H, H, H] : [1, 2, 3, 4, 5, 6, 7] }) });
    if (q.top && q.by === "command") r.ranking = [{ key: "pnpm test", label: "pnpm test", value: 12 }, { key: "git status", label: "git status", value: 7 }].slice(0, q.top);
    if (q.top && q.by === "project") r.ranking = [{ key: "cmd", label: "cmd", value: 9 * H }, { key: "site", label: "site", value: 2 * H }];
    if (q.top && q.by === "purpose") r.ranking = [{ key: "summary", label: "Summaries", value: 30 }];
    if (q.stat === "commands.failrate") r.ranking = [{ key: "pnpm test", label: "pnpm test", value: 25 }];
    if (q.stat === "agents.waiting" && q.measure === "p50") r.total = 90_000;
    r.stat.good = q.stat === "commands.failrate" ? "down" : undefined;
    return r;
  };
}

const queries = (host: ReturnType<typeof createHost>) => host.requests.filter((r) => r[0] === "stats.query").map((r) => r[1] as StatQuery);
const paneTitles = (tree: Awaited<ReturnType<typeof render>>) => tree.findAll("Pane").map((p) => p.props.title ?? null);

describe("Usage Stats", () => {
  it("shows this workspace's week: a sentence, numbers with their change, a pane per area", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    expect(tree.find("Text").children[0]).toMatchObject({ text: expect.stringMatching(/^This week: agents worked \d+h.*more than last week\.$/) });
    expect(tree).toHaveStat("Agent time", "12h");
    expect(tree).toHaveStat("Commands", "28");
    expect(tree).toHaveStat("Failed commands");
    expect(tree.findAll("Stat").map((s) => s.props.label)).toEqual(["Agent time", "Turns", "Commands", "Failed commands", "Tokens"]);
    expect(tree.find("Stat", "Agent time").props.delta).toBe("+100%");
    expect(tree.find("Stat", "Failed commands").props.deltaTone).toBe("danger"); // up, where down is good
    expect(paneTitles(tree)).toEqual([null, "Agent time", "Turns", "Commands", "When agents work", "Tokens"]);
    expect(tree.find("Ranking").props.rows).toEqual([{ key: "pnpm test", label: "pnpm test", value: 12, note: "25% failed" }, { key: "git status", label: "git status", value: 7, note: "" }]);
    expect(tree.text()).toContain("Agents waited on you 7h, 1m 30s at a time.");
    expect(tree.find("PunchCard").props.rows).toHaveLength(7);
    // This workspace's only: no query names a scope, and none reads what has no workspace.
    expect(queries(host).every((q) => !q.scope && q.stat !== "you.active" && q.stat !== "ai.calls")).toBe(true);
    expect(tree.find("StatusLine")).toBeTruthy();
  });

  it("counts every workspace from the title menu: active time, projects and cmd's model calls too", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    expect(tree.findAll("Stat").map((s) => s.props.label)).toEqual(["Agent time", "Active time", "Turns", "Commands", "Failed commands", "Tokens"]);
    expect(paneTitles(tree)).toEqual([null, "Agent time", "Turns", "Commands", "When you work", "Projects", "Tokens", "cmd's model calls"]);
    expect(tree.find("Text").children[0]).toMatchObject({ text: expect.stringContaining("across 2 projects") });
    expect(queries(host).slice(-11).every((q) => q.scope === "all")).toBe(true);
  });

  it("switches the range, kept per window, and draws a year as a calendar, today by the hour", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    await tree.change(tree.find("ToolbarSegmented"), "year");
    expect(host.requests).toContainEqual(["state.set", "range", "year"]);
    expect(queries(host).some((q) => q.range === "year" && q.stat === "agents.time")).toBe(true);
    expect(queries(host).some((q) => q.range === "365d" && q.grain === "day")).toBe(true);
    expect(tree.findAll("Calendar")).toHaveLength(1);
    expect(tree.find("Text").children[0]).toMatchObject({ text: expect.stringMatching(/^This year:/) });
    await tree.change(tree.find("ToolbarSegmented"), "today");
    expect(tree.find("Pane", (p) => p.props.title === "When agents work").props.aside).toBe("per hour");
    expect(tree.findAll("PunchCard")).toHaveLength(0);
  });

  it("opens a number's detail, splits it by what it can be split by, and goes back", async () => {
    const dims = [{ id: "result", title: "Result" }, { id: "command", title: "Command" }, { id: "project", title: "Project" }, { id: "workspace", title: "Workspace" }];
    const host = createHost({ stats: answers({ "commands.runs": (q) => Object.assign(answers()({ ...q, stat: "x" }), { stat: { id: "commands.runs", title: "Commands", description: "Commands run in terminals.", unit: "count" as const, dims, class: "output" }, ...(q.by ? { ranking: [{ key: "ok", label: "Worked", value: 20 }, { key: "fail", label: "Failed", value: 8 }] } : {}) }) }) });
    const tree = await render(<UsageStats />, host);
    await tree.press(tree.find("Stat", "Commands"));
    expect(tree.find("Pane").props.title).toBe("Commands");
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "Commands run in terminals." });
    const split = tree.findAll("ToolbarSegmented")[1]!;
    // In one workspace, no split by workspace or project.
    expect((split.props.options as { label: string }[]).map((o) => o.label)).toEqual(["Total", "Result", "Command"]);
    await tree.change(split, "result");
    expect(queries(host).at(-1)).toMatchObject({ stat: "commands.runs", by: "result", top: 12, compare: true });
    expect(tree.find("Pane", (p) => p.props.title === "By result").children).toHaveLength(1);
    await tree.press(tree.find("ToolbarButton"));
    expect(tree.findAll("Stat")).toHaveLength(5);
  });

  it("says when nothing has been counted yet", async () => {
    const none = (q: StatQuery) => stat(q, { values: [0, 0, 0, 0, 0, 0, 0], unit: q.stat.startsWith("agents.time") ? "ms" : "count" });
    const tree = await render(<UsageStats />, createHost({ stats: none }));
    expect(tree.find("Text").children[0]).toMatchObject({ text: "This week: no agent work yet." });
    expect(tree.find("Ranking").props.empty).toBe("No commands yet");
    expect(tree.find("Stat", "Commands").props.delta).toBeUndefined();
  });

  it("shows loading until the numbers come", async () => {
    const tree = await render(<UsageStats />, createHost({ stats: () => new Promise<never>(() => {}) as unknown as StatResult }));
    expect(tree).toShowState("loading");
    expect(tree.findAll("ToolbarSegmented")).toHaveLength(1); // the range can change while it loads
  });

  it("says why when no stat can be read, and asks again from Try Again", async () => {
    const host = createHost({ stats: answers(), deny: { "stats.query": 'events: ["agents"]' } });
    const tree = await render(<UsageStats />, host);
    expect(tree).toShowState("error", "Couldn't count");
    expect(JSON.stringify(tree.find("View").props.state)).toContain('Add \\"events: [\\"agents\\"]\\"');
    const before = queries(host).length;
    await tree.choose(tree.find("View"), "Try Again", "state");
    expect(queries(host).length).toBeGreaterThan(before);
  });

  it("leaves out the pane of a stat it can't read", async () => {
    const tree = await render(<UsageStats />, createHost({ stats: answers({ "agents.tokens": () => { throw new Error("“Tokens” counts every workspace together"); } }) }));
    expect(tree.findAll("Stat").map((s) => s.props.label)).not.toContain("Tokens");
    expect(paneTitles(tree)).not.toContain("Tokens");
    expect(tree).toHaveStat("Agent time");
  });

  it("ranks many commands and splits agent time by many agents", async () => {
    const agents = Array.from({ length: 7 }, (_, i) => ({ key: `a${i}`, label: `Agent ${i}`, values: [H, 0, H, 0, H, 0, H] }));
    const tree = await render(<UsageStats />, createHost({ stats: answers({
      "commands.runs": (q) => Object.assign(stat(q), { ranking: Array.from({ length: q.top ?? 8 }, (_, i) => ({ key: `c${i}`, label: `command ${i}`, value: 100 - i })) }),
      "agents.time": (q) => stat(q, { unit: "ms", series: agents }),
    }) }));
    expect((tree.find("Ranking").props.rows as unknown[]).length).toBe(8);
    expect((tree.find("TimeBars").props.series as unknown[]).length).toBe(7);
    expect(tree.find("TimeBars").props.summary).toBe("Agent 0 14%");
  });

  it("asks again a moment after a command is recorded", async () => {
    let runs = 3;
    const host = createHost({ stats: answers({ "commands.runs": (q) => Object.assign(stat(q, { values: [0, 0, 0, 0, 0, 0, runs] }), { ranking: [] }) }) });
    const tree = await render(<UsageStats />, host);
    expect(tree).toHaveStat("Commands", "3");
    runs = 4;
    host.emit(command({ command: "true", exitCode: 0 }));
    await new Promise((r) => setTimeout(r, SETTLE_MS + 100));
    await tree.idle();
    expect(tree).toHaveStat("Commands", "4");
  });

  it("writes numbers as the Stats window does", () => {
    expect([duration(0), duration(45_000), duration(150_000), duration(3 * H + 12 * 60_000), duration(26 * H)]).toEqual(["0", "45s", "2m 30s", "3h 12m", "1d 2h"]);
    expect([value(12_345, "count"), value(1536, "bytes"), value(4.25, "percent"), value(42, "percent")]).toEqual(["12.3K", "1.5 KB", "4.3%", "42%"]);
    expect([change(12, 10), change(9, 10), change(5, 0), change(0, 0), change(12, 10, "percent")]).toEqual(["+20%", "−10%", "new", "", "+2 pt"]);
    const r = stat({ compare: true });
    expect(delta({ ...r, stat: { ...r.stat, good: "up" } })).toEqual({ delta: "+100%", deltaTone: "success" });
    expect(delta(stat())).toEqual({});
    expect(sentence({}, "week")).toBe("");
  });
});
