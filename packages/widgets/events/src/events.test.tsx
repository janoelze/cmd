// Event Log against the fake host (@cmd/widget-api/testing): the native Event Stream's job. Rows
// newest first with their plain values; an event recorded again replaces its row, moves up and
// says how often; the list edge to edge (a Panel) and a chip naming the class;
// the filter and the Show menu, with their no-results states; a click opens the event whole;
// Pause holds the rows and counts what waits, Clear starts over; every workspace's from the
// title menu, live; the empty state; many rows, the newest drawn. API 1.2: a row's title is the
// log's line, the Show menu the log's classes (families on an older cmd), Copy Event and Copy ID.

import { describe, expect, it, vi } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import EventLog, { SHOW, classOf, details, familyOf } from "./events.tsx";

const { event, command, pane } = fixtures;
const titles = (rows: { props: Record<string, unknown> }[]) => rows.map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1]);

describe("Event Log", () => {
  it("lists events newest first, each with its kind and the plain values its data carries", async () => {
    const host = createHost({
      events: [event({ type: "git.commit", at: Date.now() - 60_000, data: { subject: "Fix add()", files: 2 } }), command({ command: "pnpm test", exitCode: 1, ago: 30_000, took: 4000 }), event({ type: "agent.stop", data: { agent: "Tours", nested: { a: 1 } } })],
    });
    const tree = await render(<EventLog />, host);
    expect(titles(tree.rows())).toEqual(["agent.stop", "command", "git.commit"]);
    expect(JSON.stringify(tree.rows()[0])).toContain("agent Tours");
    expect(JSON.stringify(tree.rows()[0])).not.toContain("nested");
    expect(JSON.stringify(tree.rows()[1])).toMatch(/command pnpm test · exitCode 1 · cwd .* · lasted 4\.0 s/);
    expect(tree.text()).toContain("agent");
    expect(tree.find("Window").props.status).toBe("2/min"); // the commit was a minute ago
  });

  it("replaces an event recorded again and moves it up", async () => {
    const host = createHost({ terminals: [pane()], events: [command({ command: "pnpm e2e", ago: 10_000, key: "c1" }), event({ type: "note", data: { text: "hi" } })] });
    const tree = await render(<EventLog />, host);
    expect(titles(tree.rows())).toEqual(["note", "command"]);
    host.emit(command({ command: "pnpm e2e", ago: 10_000, exitCode: 0, took: 9000, key: "c1" }));
    await tree.idle();
    expect(titles(tree.rows())).toEqual(["command", "note"]);
    expect(JSON.stringify(tree.rows()[0])).toContain("exitCode 0");
    expect(JSON.stringify(tree.rows()[0])).toContain("recorded again ×1");
    host.emit(command({ command: "pnpm e2e", ago: 10_000, exitCode: 0, took: 9500, key: "c1" }));
    await tree.idle();
    expect(tree.rows()).toHaveLength(2);
    expect(JSON.stringify(tree.rows()[0])).toContain("recorded again ×2");
    expect(JSON.stringify(tree.rows()[1])).not.toContain("recorded again");
  });

  it("runs to the window's edges under the filter, a row's chip naming its class as Settings does", async () => {
    const tree = await render(<EventLog />, createHost({ events: [command({ command: "ls", exitCode: 0 }), event({ type: "git.commit", data: {} })] }));
    expect(tree.findAll("Panel")).toHaveLength(1);
    expect(tree.findAll("View")).toHaveLength(0);
    expect(tree.find("Panel").children.map((c) => (c as { type: string }).type)).toEqual(["WindowToolbar", "PanelBody"]);
    expect(tree.findAll("Chip").map((c) => JSON.stringify(c.children))).toEqual([expect.stringContaining("Git"), expect.stringContaining("Command output")]);
  });

  it("titles a row with the log's line for the event, its type beside", async () => {
    const tree = await render(<EventLog />, createHost({ events: [command({ command: "pnpm test", exitCode: 0 }), event({ type: "git.commit", text: "Committed “Fix the footer”", data: {} })] }));
    expect(titles(tree.rows())).toEqual(["Committed “Fix the footer”", "command"]);
    expect(JSON.stringify(tree.rows()[0])).toContain('"detail":"git.commit"');
  });

  it("filters by any word in an event, and hides the log's classes from the Show menu", async () => {
    const host = createHost({ events: [command({ command: "pnpm test", exitCode: 1 }), event({ type: "git.commit", data: { subject: "Release" } }), event({ type: "git.push", data: { branch: "main" } })] });
    const tree = await render(<EventLog />, host);
    await tree.change(tree.find("ToolbarSearchField"), "release");
    expect(titles(tree.rows())).toEqual(["git.commit"]);
    expect(tree.find("ToolbarSearchField").props.count).toBe("1");
    await tree.change(tree.find("ToolbarSearchField"), "nothing-like-it");
    expect(tree).toShowState("empty", "Nothing matches");
    await tree.choose(tree.find("EmptyState"), "Clear Filter");
    expect(tree.rows()).toHaveLength(3);
    const show = tree.find("ToolbarMenu");
    expect((show.props.menu as { label?: string }[]).map((m) => m.label)).toEqual(["Command output", "Git", undefined, "Show All"]);
    await tree.choose(show, "Git");
    expect(titles(tree.rows())).toEqual(["command"]);
    expect(tree.find("ToolbarMenu").props.label).toBe("1 hidden");
    expect(host.requests).toContainEqual(["state.set", "hiddenClasses", ["git"]]);
    await tree.choose(tree.find("ToolbarMenu"), "Command output");
    expect(tree).toShowState("empty", "Nothing matches");
    await tree.choose(tree.find("EmptyState"), "Show All");
    expect(tree.rows()).toHaveLength(3);
  });

  it("hides the families of types on a cmd before 1.2, which has no classes to name", async () => {
    const older = createHost({ env: { api: { major: 1, minor: 1 }, verbs: ["events.query"], elements: undefined }, events: [command({ command: "ls", exitCode: 0 }), event({ type: "git.push" })] });
    const tree = await render(<EventLog />, older);
    expect((tree.find("ToolbarMenu").props.menu as { label?: string }[]).map((m) => m.label)).toEqual(["command", "git", undefined, "Show All"]);
    expect(older.requests.some((r) => r[0] === "events.classes")).toBe(false);
  });

  it("copies an event, or its ID, from the row's menu", async () => {
    const host = createHost({ events: [event({ type: "note", key: "note:1", data: { text: "hi" } })] });
    const tree = await render(<EventLog />, host);
    await tree.choose(tree.rows()[0]!, "Copy ID");
    await tree.choose(tree.rows()[0]!, "Copy Event");
    expect(host.calls[0]).toEqual(["clipboard.write", "note:1"]);
    expect(host.calls[1]![0]).toBe("clipboard.write");
    expect(JSON.parse(host.calls[1]![1] as string)).toMatchObject({ type: "note", key: "note:1", data: { text: "hi" } });
  });

  it("opens an event whole under its row, and goes to its terminal from the row's menu", async () => {
    const host = createHost({ terminals: [pane()], events: [command({ command: "ls", exitCode: 0, terminalId: "t-zsh" }), event({ type: "note" })] });
    const tree = await render(<EventLog />, host);
    await tree.press(tree.rows()[1]!);
    expect(tree.rows()[1]!.props.selected).toBe(true);
    expect(tree.findAll("CodeBlock")).toHaveLength(1);
    expect(JSON.stringify(tree.find("CodeBlock"))).toContain('\\"command\\": \\"ls\\"');
    await tree.press(tree.rows()[1]!);
    expect(tree.findAll("CodeBlock")).toHaveLength(0);
    await tree.choose(tree.rows()[1]!, "Show Terminal");
    expect(host.calls).toEqual([["windows.select", "t-zsh"]]);
    expect((tree.rows()[0]!.props.menu as { label: string; disabled?: boolean }[]).find((m) => m.label === "Show Terminal")?.disabled).toBe(true);
    await tree.choose(tree.rows()[0]!, "Only note");
    expect(tree.find("ToolbarSearchField").props.value).toBe("note");
  });

  it("holds its rows while paused and counts what waits; Clear starts over", async () => {
    const host = createHost({ events: [event({ type: "note", data: { text: "one" } })] });
    const tree = await render(<EventLog />, host);
    await tree.choose(tree.find("Window"), "Pause");
    host.emit(event({ type: "note", at: Date.now() + 5, data: { text: "two" } }), event({ type: "note", at: Date.now() + 6, data: { text: "three" } }));
    await tree.idle();
    expect(tree.rows()).toHaveLength(1);
    expect(tree.find("Window").props.status).toBe("Paused · 2 waiting");
    await tree.choose(tree.find("Window"), "Resume");
    expect(tree.rows()).toHaveLength(3);
    // Clear after the two came (they were stamped a few ms ahead), whatever the machine's speed.
    vi.useFakeTimers({ shouldAdvanceTime: true });
    vi.advanceTimersByTime(20);
    await tree.choose(tree.find("Window"), "Clear");
    vi.useRealTimers();
    expect(tree).toShowState("empty", "Nothing recorded yet");
    host.emit(event({ type: "note", at: Date.now() + 1000, data: { text: "after" } }));
    await tree.idle();
    expect(tree.rows()).toHaveLength(1);
  });

  it("stays paused across a reload, holding what came before it paused", async () => {
    const host = createHost({ events: [event({ type: "note", at: Date.now() - 60_000 }), event({ type: "git.commit", at: Date.now() - 1000 })], state: { pausedAt: Date.now() - 30_000 } });
    const tree = await render(<EventLog />, host);
    expect(titles(tree.rows())).toEqual(["note"]);
    expect(tree.find("Window").props.status).toBe("Paused · 1 waiting");
  });

  it("reads every workspace's events from the title menu, live", async () => {
    const host = createHost({ events: [event({ type: "note" }), event({ type: "git.commit", workspaceId: "ws-2" })] });
    const tree = await render(<EventLog />, host);
    expect(titles(tree.rows())).toEqual(["note"]);
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(titles(tree.rows())).toEqual(["git.commit", "note"]);
    expect(host.subscriptions()).toContainEqual(expect.objectContaining({ topic: "events", query: { limit: 500, scope: "all" } }));
    host.emit(event({ type: "agent.prompt", workspaceId: "ws-3" }));
    await tree.idle();
    expect(titles(tree.rows())[0]).toBe("agent.prompt");
  });

  it("says what goes here when nothing was recorded", async () => {
    const tree = await render(<EventLog />, createHost({ events: [] }));
    expect(tree).toShowState("empty", "Nothing recorded yet");
    expect(tree.find("Window").props.status).toBeNull();
  });

  it("draws the newest of many", async () => {
    const t0 = Date.now() - 400_000;
    const tree = await render(<EventLog />, createHost({ events: Array.from({ length: 450 }, (_, i) => event({ type: `kind${i % 5}.x`, at: t0 + i * 100 })) }));
    expect(tree.rows()).toHaveLength(SHOW);
    expect(tree.rows()[0]).toHaveTitle("kind4.x");
  });

  it("names kinds and values without knowing any type", () => {
    expect(familyOf("agent.stop")).toBe("agent");
    expect(familyOf("note")).toBe("note");
    const classes = fixtures.classes();
    expect(["agent.stop", "command", "agent.output", "notification", "git.push", "data.prune"].map((t) => classOf(t, classes))).toEqual(["agents", "output", "output", "notes", "git", "system"]);
    expect(details(event({ type: "x", at: 0, until: 90_000, data: { a: "b", n: null, o: {} } }))).toEqual(["a b", "lasted 2 min"]);
  });
});
