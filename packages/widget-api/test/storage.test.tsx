// cmd.storage and useStorage (API 1.3) in a widget's process, against the fake host: the three
// scopes and `cmd.state` as the window's, a set from another window reaching `useStorage`, and
// the migration run before the first render (kept: the widget renders; thrown: it shows why
// and the host hears `migrated` with ok false).

import { describe, expect, it } from "vitest";
import { render, createHost } from "@cmd/widget-api/testing";
import { cmd, useStorage, Button, Text, View } from "@cmd/widget-api";

describe("cmd.storage", () => {
  it("keeps values per scope; the window's are cmd.state's", async () => {
    const host = createHost({ state: { tab: "all" }, storage: { package: { notes: ["a"] } } });
    await render(() => null, host);
    expect(await cmd.storage.window.get("tab")).toBe("all");
    await cmd.storage.window.set("sort", "name");
    expect(await cmd.state.get("sort")).toBe("name");
    expect(await cmd.storage.package.get("notes")).toEqual(["a"]);
    expect(await cmd.storage.get("package", "notes")).toEqual(["a"]);
    await cmd.storage.workspace.set("todo", 1);
    expect(await cmd.storage.workspace.keys()).toEqual(["todo"]);
    await cmd.storage.workspace.delete("todo");
    expect(await cmd.storage.workspace.get("todo")).toBeNull();
    expect(await cmd.storage.package.history("runs", 2)).toEqual([2]);
    expect(host.storage("window")).toEqual({ tab: "all", sort: "name" });
    expect(host.calls).toEqual([]); // a widget's own storage isn't an act
  });
});

describe("useStorage", () => {
  function Count() {
    const [n, setN] = useStorage("package", "count", 0);
    return (
      <View>
        <Text>{`count ${n}`}</Text>
        <Button onClick={() => setN((x) => x + 1)}>add</Button>
      </View>
    );
  }

  it("keeps a set, and shows another window's", async () => {
    const host = createHost({ storage: { package: { count: 2 } } });
    const tree = await render(<Count />, host);
    expect(tree.text()).toContain("count 2");
    await tree.press(tree.find("Button"));
    expect(tree.text()).toContain("count 3");
    expect(host.storage("package")).toEqual({ count: 3 });
    host.set({ storage: { package: { count: 10 } } });
    await tree.idle();
    expect(tree.text()).toContain("count 10");
    host.set({ storage: { package: { count: null } } }); // deleted: back to the initial value
    await tree.idle();
    expect(tree.text()).toContain("count 0");
  });

  it("has a window's value on the first render", async () => {
    function Tab() {
      const [tab] = useStorage("window", "tab", "all");
      return <Text>{tab}</Text>;
    }
    const tree = await render(<Tab />, createHost({ state: { tab: "busy" } }));
    expect(tree.mirror.trees).toBe(1);
    expect(tree.text()).toBe("busy");
  });
});

describe("migrations", () => {
  it("run before the first render, with cmd.storage", async () => {
    const seen: [number, number][] = [];
    cmd.storage.migrate(async (from, to) => {
      seen.push([from, to]);
      const notes = await cmd.storage.package.get<string>("notes");
      await cmd.storage.package.set("notes", notes ? notes.split(",") : []);
    });
    function Notes() {
      const [notes] = useStorage<string[]>("package", "notes", []);
      return <Text>{notes.join(" / ")}</Text>;
    }
    const host = createHost({ storage: { package: { notes: "a,b" }, from: 1, to: 2 } });
    const tree = await render(<Notes />, host);
    expect(seen).toEqual([[1, 2]]);
    expect(host.migrated).toEqual({ ok: true });
    expect(tree.text()).toBe("a / b");
  });

  it("that throw show why instead of the widget", async () => {
    cmd.storage.migrate(() => {
      throw new Error("notes isn't a list");
    });
    const host = createHost({ storage: { from: 2, to: 3 } });
    const tree = await render(<Text>hello</Text>, host);
    expect(host.migrated).toEqual({ ok: false, message: "notes isn't a list" });
    expect(tree.text()).not.toContain("hello");
    expect(tree.text()).toContain("Couldn't update this widget's stored data: notes isn't a list. Its data is as it was.");
  });

  it("with none registered, says it ran", async () => {
    cmd.storage.migrate(() => {});
    const host = createHost({ storage: { from: 1, to: 2 } });
    await render(<Text>hello</Text>, host);
    expect(host.migrated).toEqual({ ok: true });
  });
});
