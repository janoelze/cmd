// @cmd/widget-api/testing's own surface (docs/56 phase 3): each matcher passes and fails with a
// message that says what the tree has, the finders (rows, sections, find), the hands (press,
// change, submit, choose a menu entry or a state's action), and host.calls recording acts.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures, matchers, titleOf, type RenderedTree } from "@cmd/widget-api/testing";
import { Window, View, WindowToolbar, ToolbarSearchField, ToolbarField, List, ListSection, ListRow, ListRowContent, Stat, EmptyState, Callout, useTerminals, useStoredState, cmd } from "@cmd/widget-api";

/** A widget with a bit of everything: a filter, sections of rows, a stat, a state when nothing matches. */
function Sample() {
  const terminals = useTerminals();
  const [q, setQ] = useStoredState<string>("q", "");
  const [note, setNote] = useStoredState<string>("note", "");
  const shown = terminals.filter((t) => t.title.includes(q));
  const busy = shown.filter((t) => t.command);
  return (
    <Window status={`${busy.length} busy`} menu={[{ label: "Clear Filter", run: () => setQ("") }, { label: "More", submenu: [{ label: "Note", run: () => setNote("menu") }] }]}>
      <View state={terminals.length && !shown.length ? { kind: "noResults", title: "No matches", action: { label: "Show All", run: () => setQ("") } } : null}>
        <WindowToolbar>
          <ToolbarSearchField value={q} onChange={setQ} />
          <ToolbarField value={note} onSubmit={setNote} />
        </WindowToolbar>
        <Stat label="Busy" value={busy.length} />
        <List>
          <ListSection title="Busy" count={busy.length}>
            {busy.map((t) => (
              <ListRow key={t.id} onClick={() => void cmd.windows.select(t.windowId!)}>
                <ListRowContent title={t.title} detail={t.command} />
              </ListRow>
            ))}
          </ListSection>
          <ListSection title="Idle">
            {shown
              .filter((t) => !t.command)
              .map((t) => (
                <ListRow key={t.id}>
                  <ListRowContent title={t.title} />
                </ListRow>
              ))}
          </ListSection>
        </List>
        {note ? <Callout tone="danger" title={note} /> : null}
        {!terminals.length ? <EmptyState title="No terminals" /> : null}
      </View>
    </Window>
  );
}

const { pane } = fixtures;
const host = () => createHost({ terminals: [pane({ title: "api", command: "pnpm dev" }), pane({ title: "web", command: "vite" }), pane({ title: "zsh" })] });
const fails = (fn: () => void) => {
  try {
    fn();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected the assertion to fail");
};

describe("the matchers", () => {
  it("toHaveSection: by title, with the count prop or the rows it holds", async () => {
    const tree = await render(<Sample />, host());
    expect(tree).toHaveSection("Busy", { count: 2 });
    expect(tree).toHaveSection("Idle", { count: 1 }); // no count prop: its rows
    expect(tree).not.toHaveSection("Waiting");
    expect(fails(() => expect(tree).toHaveSection("Busy", { count: 3 }))).toMatch(/section "Busy" with count 3; sections: "Busy" \(2\), "Idle" \(–\)/);
  });

  it("toHaveRow: by title, or a RegExp over its words", async () => {
    const tree = await render(<Sample />, host());
    expect(tree).toHaveRow("api");
    expect(tree).toHaveRow(/vite/);
    expect(tree).not.toHaveRow("db");
    expect(fails(() => expect(tree).toHaveRow("db"))).toMatch(/row db; rows: "api", "web", "zsh"/);
  });

  it("toHaveTitle: a row's, a section's, a stat's", async () => {
    const tree = await render(<Sample />, host());
    expect(tree.rows()[0]).toHaveTitle("api");
    expect(tree.sections()[1]).toHaveTitle("Idle");
    expect(tree.find("Stat")).toHaveTitle("Busy");
    expect(fails(() => expect(tree.rows()[0]).toHaveTitle("web"))).toBe('expected title "web", got "api"');
  });

  it("toHaveStat: by label, and by value when given", async () => {
    const tree = await render(<Sample />, host());
    expect(tree).toHaveStat("Busy");
    expect(tree).toHaveStat("Busy", 2);
    expect(tree).toHaveStat("Busy", "2");
    expect(fails(() => expect(tree).toHaveStat("Busy", 5))).toMatch(/stat "Busy" = 5; stats: Busy = 2/);
  });

  it("toShowState: a View's state, an EmptyState, a danger Callout", async () => {
    expect(await render(<Sample />, createHost())).toShowState("empty", "No terminals");
    const filtered = await render(<Sample />, createHost({ terminals: [pane()], state: { q: "nothing" } }));
    expect(filtered).toShowState("noResults", "No matches");
    expect(filtered).not.toShowState("empty");
    const noted = await render(<Sample />, createHost({ terminals: [pane()], state: { note: "Couldn't reach the API" } }));
    expect(noted).toShowState("error", "Couldn't reach the API");
    expect(fails(() => expect(filtered).toShowState("error"))).toMatch(/error state; shown: noResults "No matches"/);
  });

  it("refuse anything but render()'s tree", () => {
    expect(() => matchers.toHaveRow({}, "x")).toThrow("expected the tree that render() returns");
  });
});

describe("the tree and its hands", () => {
  it("finds rows, sections and elements, and fails a find with the tree", async () => {
    const tree = await render(<Sample />, host());
    expect(tree.rows().map((r) => titleOf(r))).toEqual(["api", "web", "zsh"]);
    expect(tree.sections()).toHaveLength(2);
    expect(tree.find("ListSection", "Idle").props.title).toBe("Idle");
    expect(() => tree.find("Sparkline")).toThrow(/no Sparkline in the tree:\n<Window/);
    expect(tree.text()).toContain("pnpm dev");
  });

  it("press: a row's onClick, recorded in host.calls", async () => {
    const h = host();
    const tree = await render(<Sample />, h);
    await tree.press(tree.rows()[1]!);
    expect(h.calls).toEqual([["windows.select", "w-web"]]);
    await expect(tree.press(tree.rows()[2]!)).rejects.toThrow('ListRow "zsh" has no onClick or onSelect or onToggle');
  });

  it("change and submit: a field's value, as the app sends it", async () => {
    const h = host();
    const tree = await render(<Sample />, h);
    await tree.change(tree.find("ToolbarSearchField"), "ap");
    expect(tree.rows()).toHaveLength(1);
    expect(h.requests).toContainEqual(["state.set", "q", "ap"]);
    await tree.submit(tree.find("ToolbarField"), "Saved");
    expect(tree).toShowState("error", "Saved");
  });

  it("choose: a menu entry (in a submenu too) and a View state's action", async () => {
    const tree = await render(<Sample />, createHost({ terminals: [pane()], state: { q: "nothing" } }));
    await tree.choose(tree.find("View"), "Show All");
    expect(tree.rows()).toHaveLength(1);
    await tree.choose(tree.find("Window"), "Note");
    expect(tree).toShowState("error", "menu");
    await expect(tree.choose(tree.find("Window"), "Nope")).rejects.toThrow('has no menu entry "Nope"');
  });

  it("host.calls has the acts only; host.requests every call", async () => {
    const h = host();
    const tree: RenderedTree = await render(<Sample />, h);
    await tree.press(tree.rows()[0]!);
    expect(h.calls.map((c) => c[0])).toEqual(["windows.select"]);
    expect(h.requests.map((c) => c[0])).toContain("windows.select");
    expect(h.requests.length).toBeGreaterThanOrEqual(h.calls.length);
  });
});
