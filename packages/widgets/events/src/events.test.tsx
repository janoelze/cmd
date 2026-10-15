// Event Log against the fake host (@cmd/widget-api/testing): the native Event Stream's job, drawn
// as it is. Rows newest first with their type and plain values; an event recorded again replaces
// its row, moves up and says how often (useEvents' `again`); the list edge to edge (a Panel), a
// chip naming the class in its name's hue (fmt.hue); the filter, and the log's classes in the
// title menu ("All Events", "1 hidden"), kept for every Event Log (package storage), with the
// native's no-results line; a click opens the event whole; the row's menu in the native's order;
// Pause holds the rows and counts what waits, Clear starts over; every workspace's from the
// title menu, live; the empty state; many rows, the newest drawn; times in the app's locale.

import { describe, expect, it, vi } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import { fmt } from "@cmd/widget-api";
import EventLog, { SHOW, classOf, details } from "./events.tsx";

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
    expect(tree.findAll("Chip").map((c) => c.props.hue)).toEqual([fmt.hue("git"), fmt.hue("output")]);
  });

  it("writes each event's time of day, to the second, in the app's locale", async () => {
    const at = new Date(2026, 9, 16, 14, 5, 9).getTime();
    const tree = await render(<EventLog />, createHost({ env: { locale: "de-DE" }, events: [event({ type: "note", at })] }));
    expect(tree.find("ListValue")).toHaveProperty("children", [expect.objectContaining({ text: "14:05:09" })]);
  });

  it("titles a row with the log's line for the event, its type beside", async () => {
    const tree = await render(<EventLog />, createHost({ events: [command({ command: "pnpm test", exitCode: 0 }), event({ type: "git.commit", text: "Committed “Fix the footer”", data: {} })] }));
    expect(titles(tree.rows())).toEqual(["Committed “Fix the footer”", "command"]);
    expect(JSON.stringify(tree.rows()[0])).toContain('"detail":"git.commit"');
  });

  it("filters by any word in an event, and hides the log's classes from the title menu for every Event Log", async () => {
    const host = createHost({ events: [command({ command: "pnpm test", exitCode: 1 }), event({ type: "git.commit", data: { subject: "Release" } }), event({ type: "git.push", data: { branch: "main" } })] });
    const tree = await render(<EventLog />, host);
    await tree.change(tree.find("ToolbarSearchField"), "release");
    expect(titles(tree.rows())).toEqual(["git.commit"]);
    expect(tree.find("ToolbarSearchField").props.count).toBe("1");
    await tree.change(tree.find("ToolbarSearchField"), "nothing-like-it");
    expect(tree).toShowState("empty", "Nothing matches");
    expect(tree.find("EmptyState").props.text).toBe("Change the filter, or show the classes you hid.");
    await tree.change(tree.find("ToolbarSearchField"), "");
    const win = () => tree.find("Window");
    expect(win().props.menuLabel).toBe("All Events");
    // Every class cmd lists, in its order, after the scope, Pause and Clear: as the native title menu.
    expect((win().props.menu as { label?: string }[]).map((m) => m.label)).toEqual(["This Workspace", "All Workspaces", undefined, "Pause", "Clear", undefined, "Agent events", "Command output", "Your actions", "Git", "Notes and notifications", "Show All"]);
    const labels = (l: unknown) => (l as { label?: string }[]).map((m) => m.label);
    expect(labels(win().props.actions)).toEqual(labels(win().props.menu));
    await tree.choose(win(), "Git");
    expect(titles(tree.rows())).toEqual(["command"]);
    expect(win().props.menuLabel).toBe("1 hidden");
    expect(host.storage("package")).toEqual({ hiddenClasses: ["git"] });
    await tree.choose(win(), "Command output");
    expect(tree).toShowState("empty", "Nothing matches");
    await tree.choose(win(), "Show All");
    expect(tree.rows()).toHaveLength(3);
  });

  it("starts with the classes another Event Log hid, and follows when it changes them", async () => {
    const host = createHost({ storage: { package: { hiddenClasses: ["output"] } }, events: [command({ command: "ls", exitCode: 0 }), event({ type: "git.push" })] });
    const tree = await render(<EventLog />, host);
    expect(titles(tree.rows())).toEqual(["git.push"]);
    host.set({ storage: { package: { hiddenClasses: [] } } });
    await tree.idle();
    expect(tree.rows()).toHaveLength(2);
  });

  it("copies an event, or its ID, from the row's menu", async () => {
    const host = createHost({ events: [event({ type: "note", key: "note:1", data: { text: "hi" } })] });
    const tree = await render(<EventLog />, host);
    await tree.choose(tree.rows()[0]!, "Copy ID");
    await tree.choose(tree.rows()[0]!, "Copy Event");
    expect(host.calls[0]).toEqual(["clipboard.write", "note:1"]);
    expect(host.calls[1]![0]).toBe("clipboard.write");
    expect(JSON.parse(host.calls[1]![1] as string)).toMatchObject({ type: "note", key: "note:1", data: { text: "hi" } });
    expect((tree.rows()[0]!.props.menu as { label?: string }[]).map((m) => m.label)).toEqual(["Copy Event", "Copy ID", undefined, "Only note"]);
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
    expect((tree.rows()[0]!.props.menu as { label?: string }[]).some((m) => m.label === "Show Terminal")).toBe(false);
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

  it("names classes and values without knowing any type", () => {
    const classes = fixtures.classes();
    expect(["agent.stop", "command", "agent.output", "notification", "git.push", "data.prune"].map((t) => classOf(t, classes))).toEqual(["agents", "output", "output", "notes", "git", "system"]);
    expect(details(event({ type: "x", at: 0, until: 90_000, data: { a: "b", n: null, o: {} } }))).toEqual(["x", "a b", "lasted 2 min"]);
  });
});
