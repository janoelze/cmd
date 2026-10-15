// Usage Stats against the fake host (@cmd/widget-api/testing): the native Stats window's job. The
// page as the native page has it in either scope (its sentence, numbers with their change as a
// Delta and a sparkline inside, a pane per area, projects and cmd's model calls in this workspace
// too); what has no workspace read across every workspace; the range, kept per window; a number
// opens its detail (its change and spread in the chart's header, split by what isn't "many",
// ranked by what is) and Back; nothing counted yet; loading; refused (the page says why, Try
// Again subscribes again); many commands ranked; live: counted again when cmd says so, no polling.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import type { StatQuery, StatResult } from "@cmd/widget-api";
import UsageStats, { change, detailQuery, firstDay, pageQueries, sentence } from "./stats.tsx";

const { stat } = fixtures;
const H = 3_600_000;
const UNIT: Record<string, StatResult["stat"]["unit"]> = { "core.memory": "bytes", "data.size": "bytes", "core.stalls": "ms", "agents.time": "ms", "agents.waiting": "ms", "you.active": "ms", "commands.failrate": "percent", "agents.tokens": "tokens" };

/** A host answering every stat: agent time by agent, turns by outcome, commands ranked; `over` per stat id. */
function answers(over: Record<string, (q: StatQuery) => StatResult> = {}) {
  return (q: StatQuery): StatResult => {
    if (over[q.stat]) return over[q.stat]!(q);
    const unit = UNIT[q.stat] ?? "count";
    const series = q.by === "agent" ? [{ key: "claude", label: "Claude", values: [H, 2 * H, 0, H, 3 * H, H, 2 * H] }, { key: "codex", label: "Codex", values: [0, H, 0, 0, H, 0, 0] }] : q.by === "outcome" ? [{ key: "done", label: "Done", values: [3, 4, 1, 2, 5, 2, 3] }, { key: "stopped", label: "Stopped", values: [0, 1, 0, 0, 1, 0, 1] }] : undefined;
    const r = stat(q, { unit, title: q.stat, ...(series ? { series } : { values: unit === "ms" ? [H, H, H, H, H, H, H] : [1, 2, 3, 4, 5, 6, 7] }) });
    if (q.top && q.by === "command") r.ranking = [{ key: "pnpm test", label: "pnpm test", value: 12 }, { key: "git status", label: "git status", value: 7 }].slice(0, q.top);
    if (q.top && q.by === "project") r.ranking = [{ key: "cmd", label: "cmd", value: 9 * H }];
    if (q.top && q.by === "purpose") r.ranking = [{ key: "summary", label: "Summaries", value: 30 }];
    if (q.stat === "commands.failrate") r.ranking = [{ key: "pnpm test", label: "pnpm test", value: 25 }];
    if (q.stat === "agents.waiting" && q.quantiles) r.quantiles = { p50: 90_000, p90: 600_000 };
    if (q.stat === "commands.failrate") r.stat.good = "down";
    if (q.stat === "core.memory") r.total = 182 * 2 ** 20;
    if (q.stat === "core.stalls") r.total = q.measure === "max" ? 240 : 2;
    if (q.stat === "data.size") r.total = 46 * 2 ** 20;
    return r;
  };
}

type Tree = Awaited<ReturnType<typeof render>>;
const subs = (host: ReturnType<typeof createHost>) => host.subscriptions().filter((s) => s.topic === "stats").map((s) => s.query as StatQuery);
const paneTitles = (tree: Tree) => tree.findAll("Pane").map((p) => p.props.title ?? null);
const PANES = [null, "Agent time", "Turns", "Commands", "When you work", "Projects", "Tokens", "cmd's model calls", "cmd"];
const UNSCOPED = ["you.active", "ai.calls", "core.memory", "core.stalls", "data.size"];

describe("Usage Stats", () => {
  it("shows this workspace's week as the native page does: a sentence, numbers with their change, a pane per area", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    expect(tree.find("Text").children[0]).toMatchObject({ text: expect.stringMatching(/^This week: agents worked \d+h.*more than last week\.$/) });
    expect(tree.findAll("Stat").map((s) => s.props.label)).toEqual(["Agent time", "Active time", "Turns", "Commands", "Failed commands", "Tokens"]);
    expect(tree).toHaveStat("Agent time", "12h");
    expect(tree).toHaveStat("Commands", "28");
    // The change is a Delta: which way it went, and green or red by which way is good.
    expect(tree.find("Stat", "Agent time").props).toMatchObject({ delta: "+100%", trend: "up" });
    expect(tree.find("Stat", "Agent time").props.good).toBeUndefined();
    expect(tree.find("Stat", "Failed commands").props).toMatchObject({ trend: "up", good: "down" });
    expect(tree.find("Stat", "Agent time").props.deltaTone).toBeUndefined();
    // The sparkline is inside the tile.
    expect(tree.find("Stat", "Agent time").children).toMatchObject([{ type: "Sparkline", props: { color: "current" } }]);
    expect(tree.find("Stat", "Commands").children).toMatchObject([{ type: "Sparkline", props: { color: "neutral" } }]);
    // Projects and cmd's model calls are on the page in this workspace too, as on the native page.
    expect(paneTitles(tree)).toEqual(PANES);
    expect(tree.find("Ranking").props.rows).toEqual([{ key: "pnpm test", label: "pnpm test", value: 12, note: "25% failed" }, { key: "git status", label: "git status", value: 7, note: "" }]);
    expect(tree.text()).toContain("Agents waited on you 7h, 1m 30s at a time.");
    expect(tree.find("PunchCard").props.rows).toHaveLength(7);
    // This workspace's, but for what has no workspace (yours, cmd's), which is every workspace's.
    expect(subs(host)).toHaveLength(14);
    expect(subs(host).every((q) => (UNSCOPED.includes(q.stat) ? q.scope === "all" : !q.scope))).toBe(true);
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: expect.stringMatching(/^Updated /) });
  });

  it("counts every workspace from the title menu, with the same panes", async () => {
    const host = createHost({ stats: answers({ "agents.time": (q) => Object.assign(answers()({ ...q, stat: "x" }), q.by === "project" ? { ranking: [{ key: "cmd", label: "cmd", value: 9 * H }, { key: "site", label: "site", value: 2 * H }] } : {}) }) });
    const tree = await render(<UsageStats />, host);
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(host.requests).toContainEqual(["state.set", "scope", "all"]);
    expect(paneTitles(tree)).toEqual(PANES);
    expect(tree.find("Text").children[0]).toMatchObject({ text: expect.stringContaining("across 2 projects") });
    expect(subs(host).every((q) => q.scope === "all")).toBe(true);
  });

  it("switches the range, kept per window, and draws a year as a calendar, today by the hour", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    await tree.change(tree.find("ToolbarSegmented"), "year");
    expect(host.requests).toContainEqual(["state.set", "range", "year"]);
    expect(subs(host).some((q) => q.range === "year" && q.stat === "agents.time")).toBe(true);
    expect(subs(host).some((q) => q.range === "365d" && q.grain === "day")).toBe(true);
    const cal = tree.find("Calendar");
    expect(cal.props.dayLabels).toHaveLength(7);
    expect(cal.props.firstDay).toBeUndefined(); // Monday first, as the native calendar
    expect(tree.find("Text").children[0]).toMatchObject({ text: expect.stringMatching(/^This year:/) });
    await tree.change(tree.find("ToolbarSegmented"), "today");
    expect(tree.find("Pane", (p) => p.props.title === "When you work").props.aside).toBe("per hour");
    expect(tree.findAll("TimeBars").find((t) => t.props.label === "Active time per hour")).toBeTruthy();
    expect(tree.findAll("PunchCard")).toHaveLength(0);
  });

  it("opens a number's detail: its change and spread in the header, split by its few-valued dimensions, and Back", async () => {
    const dims = [{ id: "result", title: "Result" }, { id: "command", title: "Command", many: true }, { id: "project", title: "Project" }, { id: "workspace", title: "Workspace" }];
    const runs = (q: StatQuery): StatResult => Object.assign(answers()({ ...q, stat: "x" }), { stat: { id: "commands.runs", title: "Commands", description: "Commands run in terminals.", unit: "count" as const, dims, class: "output", kind: "count" as const }, ...(q.by ? { ranking: [{ key: "ok", label: "Worked", value: 20 }, { key: "fail", label: "Failed", value: 8 }] } : {}) });
    const host = createHost({ stats: answers({ "commands.runs": runs }) });
    const tree = await render(<UsageStats />, host);
    await tree.press(tree.find("Stat", "Commands"));
    expect(subs(host)).toEqual([detailQuery("commands.runs", "week", null, "workspace")]);
    expect(subs(host)[0]).toMatchObject({ compare: true, quantiles: true });
    expect(tree.find("Pane").props.title).toBe("Commands");
    expect(tree.find("TimeBars").props).toMatchObject({ summary: "28", delta: { text: "+100%", trend: "up" }, height: 200, average: true });
    expect(tree.find("StatusLine").children[0]).toMatchObject({ text: "Commands run in terminals." });
    const split = tree.findAll("ToolbarSegmented")[1]!;
    // Not by command (many values: that's a ranking), nor by workspace inside one.
    expect((split.props.options as { label: string }[]).map((o) => o.label)).toEqual(["Total", "Result", "Project"]);
    await tree.change(split, "result");
    expect(subs(host)[0]).toMatchObject({ stat: "commands.runs", by: "result", top: 12 });
    expect(tree.find("Pane", (p) => p.props.title === "By result").children).toHaveLength(1);
    await tree.press(tree.find("ToolbarButton"));
    expect(tree.findAll("Stat")).toHaveLength(6);
  });

  it("draws a distribution's detail as a line, with its median and 90th percentile", async () => {
    const spread = (q: StatQuery): StatResult => {
      const r = answers()({ ...q, stat: "x" });
      r.stat = { ...r.stat, id: "agents.turns", title: "Turns", kind: "distribution", good: "down" };
      if (q.quantiles) r.quantiles = { p50: 240_000, p90: 720_000 };
      return r;
    };
    const tree = await render(<UsageStats />, createHost({ stats: answers({ "agents.turns": spread }) }));
    await tree.press(tree.find("Stat", "Turns"));
    expect(tree.findAll("TimeBars")).toHaveLength(0);
    expect(tree.find("TimeSeries").props).toMatchObject({ summary: "28", note: "median 240K, 90% under 720K", delta: { text: "+100%", trend: "up", good: "down" } });
  });

  it("reads your active time, cmd's model calls and cmd's own pane across every workspace", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    expect(tree).toHaveStat("Active time", "7h");
    expect(tree.find("Pane", (p) => p.props.title === "cmd").props.aside).toBe("core memory");
    expect(tree.find("TimeSeries").props).toMatchObject({ unit: "bytes", label: "Core memory", summary: "182 MB on average", height: 90 });
    expect(tree.text()).toContain("2 stalls of the core, the worst 240ms · event log 46 MB.");
    expect(tree.find("Ranking", (r) => r.props.empty === "No model calls yet").props.rows).toEqual([{ key: "summary", label: "Summaries", value: 30 }]);
    for (const s of UNSCOPED) expect(subs(host).filter((q) => q.stat === s).every((q) => q.scope === "all")).toBe(true);
    // Its detail reads every workspace's too: there is no other.
    await tree.pick(tree.find("TimeSeries"), 3);
    expect(subs(host)[0]).toMatchObject({ stat: "core.memory", scope: "all", compare: true });
  });

  it("says when nothing has been counted yet", async () => {
    const none = (q: StatQuery) => stat(q, { values: [0, 0, 0, 0, 0, 0, 0], unit: UNIT[q.stat] ?? "count" });
    const tree = await render(<UsageStats />, createHost({ stats: none }));
    expect(tree.find("Text").children[0]).toMatchObject({ text: "This week: no agent work yet." });
    expect(tree.find("Ranking").props.empty).toBe("No commands yet");
    expect(tree.find("Stat", "Commands").props.delta).toBeUndefined();
    expect(tree.text()).toContain("No stalls of the core.");
  });

  it("shows loading until every number is in, with the range there to change", async () => {
    const tree = await render(<UsageStats />, createHost({ stats: answers({ "data.size": () => null as unknown as StatResult }) }));
    expect(tree).toShowState("loading");
    expect(tree.findAll("ToolbarSegmented")).toHaveLength(1);
  });

  it("says why when cmd refuses a stat, and subscribes again from Try Again", async () => {
    const host = createHost({ stats: answers(), deny: { "stats.query": 'events: ["agents"]' } });
    const tree = await render(<UsageStats />, host);
    expect(tree).toShowState("error", "Couldn't count");
    expect(JSON.stringify(tree.find("View").props.state)).toContain('Add \\"events: [\\"agents\\"]\\"');
    expect(tree.findAll("ToolbarSegmented")).toHaveLength(1); // the range stays
    const before = host.messages.filter((m) => m.kind === "subscribe").length;
    await tree.choose(tree.find("View"), "Try Again", "state");
    expect(host.messages.filter((m) => m.kind === "subscribe").length).toBeGreaterThan(before);
  });

  it("shows the page's error when one stat is refused, as the native page does", async () => {
    const host = createHost({ stats: answers() });
    const tree = await render(<UsageStats />, host);
    const sub = host.subscriptions().find((s) => (s.query as StatQuery).stat === "core.memory")!;
    host.deliver({ kind: "result", id: sub.id, ok: false, error: { code: "permission", permission: 'events: ["system"]', message: 'Add "events: [\\"system\\"]" to the widget\'s permissions to use stats.query.' } });
    await tree.idle();
    expect(tree).toShowState("error", "Couldn't count");
    expect(JSON.stringify(tree.find("View").props.state)).toContain("system");
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

  it("counts again when cmd says a stat changed: live, without asking", async () => {
    let runs = 3;
    const host = createHost({ stats: answers({ "commands.runs": (q) => Object.assign(stat(q, { values: [0, 0, 0, 0, 0, 0, runs] }), { ranking: [] }) }) });
    const tree = await render(<UsageStats />, host);
    expect(tree).toHaveStat("Commands", "3");
    runs = 4;
    host.set({ stats: answers({ "commands.runs": (q) => Object.assign(stat(q, { values: [0, 0, 0, 0, 0, 0, runs] }), { ranking: [] }) }) });
    await tree.idle();
    expect(tree).toHaveStat("Commands", "4");
    // Nothing polls or asks: every number is a subscription.
    expect(host.requests.filter((r) => r[0] === "stats.query")).toHaveLength(0);
  });

  it("writes changes and the week as the Stats window does", () => {
    const r = stat({ compare: true });
    expect(change({ ...r, stat: { ...r.stat, good: "up" } })).toEqual({ text: "+100%", trend: "up", good: "up" });
    expect(change(stat())).toBeNull();
    expect(change(stat({ compare: true }, { values: [0, 0, 0, 0, 0, 0, 0] }))).toBeNull();
    expect(sentence({}, "week")).toBe("");
    expect([firstDay("en-US"), firstDay("de-DE")]).toEqual([0, 1]);
    expect(pageQueries("week", "workspace").map(([k]) => k)).toEqual(pageQueries("week", "all").map(([k]) => k));
  });
});
