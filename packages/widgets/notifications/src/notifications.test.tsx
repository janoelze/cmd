// Notification Log against the fake host (@cmd/widget-api/testing): the native Notifications'
// job, drawn as it is. Rows newest first under Today and Earlier, each with its source's icon,
// title, body and time (today's in the app's locale, earlier ones as an age); one that needs you
// in its tone; live as they are sent; a click goes to the terminal or window it is about while
// it is open, a row's menu says which and copies its text; Clear keeps when it cleared in the
// package's storage, so every Notification Log clears with it, across a reload too; every
// workspace's from the title menu; refused without the grant, with a way back; empty; many; the
// list runs to the window's edges.

import { afterAll, describe, expect, it, vi } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import NotificationLog, { KEEP, iconOf, newestFirst } from "./notifications.tsx";

// A fixed clock (only Date: timers run as usual): today at noon, so "yesterday" is 13 h ago at any hour the tests run.
vi.useFakeTimers({ now: new Date(2026, 9, 15, 12, 0, 0), toFake: ["Date"] });
afterAll(() => void vi.useRealTimers());

const { event, pane, window } = fixtures;
const note = (over: { title: string; body?: string; source?: string; urgent?: boolean; at?: number; terminalId?: string | null; windowId?: string | null; workspaceId?: string }) =>
  event({ type: "notification", at: over.at ?? Date.now(), terminalId: over.terminalId ?? null, windowId: over.windowId ?? null, ...(over.workspaceId ? { workspaceId: over.workspaceId } : {}), data: { source: over.source ?? "agent-done", title: over.title, body: over.body ?? "", urgent: !!over.urgent, alert: true } });
const yesterday = new Date(new Date().setHours(0, 0, 0, 0) - 3_600_000).getTime();
const titles = (rows: { props: Record<string, unknown> }[]) => rows.map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1]);

const log = [
  note({ title: "cmd · done", body: "Released v0.31.", at: yesterday }),
  note({ title: "Tours · needs you", body: "Allow “pnpm tour”?", source: "agent-input", urgent: true, at: Date.now() - 120_000, terminalId: "t-zsh" }),
  note({ title: "pnpm e2e · done", body: "All checks passed.", source: "command", at: Date.now() - 30_000, terminalId: "t-zsh" }),
];

describe("Notification Log", () => {
  it("lists notifications newest first under Today and Earlier, with their icon, body and time", async () => {
    const host = createHost({ terminals: [pane()], events: log });
    const tree = await render(<NotificationLog />, host);
    expect(host.subscriptions()).toContainEqual(expect.objectContaining({ topic: "events", query: { types: ["notification"], limit: KEEP } }));
    expect(tree).toHaveSection("Today", { count: 2 });
    expect(tree).toHaveSection("Earlier", { count: 1 });
    expect(titles(tree.rows())).toEqual(["pnpm e2e · done", "Tours · needs you", "cmd · done"]);
    expect(tree.findAll("ListRowIcon").map((i) => i.props.icon)).toEqual(["terminal", "person.crop.circle.badge.questionmark", "person.crop.circle.badge.checkmark"]);
    expect(tree.findAll("ListRowContent").map((c) => c.props.tone ?? null)).toEqual([null, "needs", null]);
    expect(tree.findAll("ListValue")[0]!.children[0]).toMatchObject({ text: "11:59 AM" });
    expect(tree.findAll("ListValue")[2]!.children[0]).toMatchObject({ text: "13h" });
  });

  it("writes today's times in the app's locale", async () => {
    const tree = await render(<NotificationLog />, createHost({ env: { locale: "de-DE" }, events: log }));
    expect(tree.findAll("ListValue")[0]!.children[0]).toMatchObject({ text: "11:59" });
  });

  it("shows a notification as it is sent", async () => {
    const host = createHost({ events: log });
    const tree = await render(<NotificationLog />, host);
    host.emit(note({ title: "Perf · stopped", body: "You've hit your weekly limit", at: Date.now() + 5 }));
    await tree.idle();
    expect(titles(tree.rows())[0]).toBe("Perf · stopped");
    expect(tree).toHaveSection("Today", { count: 3 });
  });

  it("goes to the terminal it is about on a click, and copies its text from the row's menu", async () => {
    const host = createHost({ terminals: [pane()], events: log });
    const tree = await render(<NotificationLog />, host);
    await tree.press(tree.rows()[1]!);
    expect(host.calls).toEqual([["windows.select", "t-zsh"]]);
    await tree.press(tree.rows()[2]!); // about no terminal: nowhere to go
    expect(host.calls).toHaveLength(1);
    expect((tree.rows()[2]!.props.menu as { label: string; disabled?: boolean }[])[0]).toMatchObject({ label: "Show Window", disabled: true });
    await tree.choose(tree.rows()[1]!, "Copy Text");
    expect(host.calls[1]).toEqual(["clipboard.write", "Tours · needs you\nAllow “pnpm tour”?"]);
  });

  it("goes to the window it is about (a widget's), and not to one that's closed", async () => {
    const host = createHost({
      windows: [window({ title: "Countdown", kind: "pkg:timer/timer" })],
      events: [note({ title: "25 min timer · done", source: "widget", windowId: "w-countdown", at: Date.now() - 5000 }), note({ title: "Gone · done", source: "widget", windowId: "w-gone", at: Date.now() - 9000 })],
    });
    const tree = await render(<NotificationLog />, host);
    expect((tree.rows()[0]!.props.menu as { label: string; disabled?: boolean }[])[0]).toMatchObject({ label: "Show Window", disabled: false });
    await tree.press(tree.rows()[0]!);
    expect(host.calls).toEqual([["windows.select", "w-countdown"]]);
    await tree.press(tree.rows()[1]!);
    expect(host.calls).toHaveLength(1);
    expect((tree.rows()[1]!.props.menu as { label: string; disabled?: boolean }[])[0]).toMatchObject({ label: "Show Window", disabled: true });
  });


  it("runs to the window's edges: a Panel, not an inset View", async () => {
    const tree = await render(<NotificationLog />, createHost({ events: log }));
    expect(tree.findAll("Panel")).toHaveLength(1);
    expect(tree.findAll("View")).toHaveLength(0);
    expect(tree.find("Panel").children.map((c) => (c as { type: string }).type)).toEqual(["PanelBody"]);
  });

  it("clears from the title menu for every Notification Log, keeps it cleared across a reload, and shows what comes after", async () => {
    const host = createHost({ events: log });
    const tree = await render(<NotificationLog />, host);
    await tree.choose(tree.find("Window"), "Clear Notifications");
    expect(tree).toShowState("empty", "No notifications");
    const cleared = host.storage("package").clearedAt;
    expect(typeof cleared).toBe("number");
    expect(host.calls).toEqual([]); // no verb: the package's storage
    host.emit(note({ title: "Later · done", at: Date.now() + 10 }));
    await tree.idle();
    expect(titles(tree.rows())).toEqual(["Later · done"]);
    const again = await render(<NotificationLog />, createHost({ events: log, storage: { package: { clearedAt: cleared! } } }));
    expect(again).toShowState("empty", "No notifications");
  });

  it("clears when another Notification Log clears, in any workspace", async () => {
    const host = createHost({ events: log });
    const tree = await render(<NotificationLog />, host);
    expect(tree.rows()).toHaveLength(3);
    host.set({ storage: { package: { clearedAt: Date.now() } } });
    await tree.idle();
    expect(tree).toShowState("empty", "No notifications");
  });

  it("reads every workspace's from the title menu, live", async () => {
    const host = createHost({ events: [...log, note({ title: "other · done", workspaceId: "ws-2", at: Date.now() - 1000 })] });
    const tree = await render(<NotificationLog />, host);
    expect(titles(tree.rows())).not.toContain("other · done");
    await tree.choose(tree.find("Window"), "All Workspaces");
    expect(titles(tree.rows())[0]).toBe("other · done");
    expect(host.subscriptions()).toContainEqual(expect.objectContaining({ topic: "events", query: { types: ["notification"], limit: KEEP, scope: "all" } }));
  });

  it("says what it needs when every workspace's are refused, and goes back to this workspace's", async () => {
    const host = createHost({ events: log, state: { scope: "all" }, deny: { "events.query": 'workspace: ["all"]' } });
    const tree = await render(<NotificationLog />, host);
    expect(tree).toShowState("error", "Notifications aren't shared with this widget");
    host.set({ deny: {} });
    await tree.choose(tree.find("View"), "Show This Workspace", "state");
    expect(tree.rows()).toHaveLength(3);
  });

  it("says what goes here when there are none", async () => {
    const tree = await render(<NotificationLog />, createHost({ events: [] }));
    expect(tree).toShowState("empty", "No notifications");
    expect(tree.find("Window").props.status).toBeNull();
  });

  it("keeps the newest of many", async () => {
    const t0 = Date.now() - 300_000;
    const host = createHost({ events: Array.from({ length: 260 }, (_, i) => note({ title: `n${i}`, at: t0 + i * 1000 })) });
    const tree = await render(<NotificationLog />, host);
    expect(tree.rows()).toHaveLength(KEEP);
    expect(tree.rows()[0]).toHaveTitle("n259");
  });

  it("names a source's icon and keeps one row per notification", () => {
    expect(iconOf("timer")).toBe("timer");
    expect(iconOf("something-new")).toBe("bell");
    const a = note({ title: "a", at: 1 });
    expect(newestFirst([a, { ...a, at: 2, data: { ...a.data, title: "a again" } }]).map((n) => n.title)).toEqual(["a again"]);
  });
});
