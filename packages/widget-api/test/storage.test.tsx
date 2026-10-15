// cmd.storage and useStorage (API 1.3) in a widget's process, against the fake host: the three
// scopes and `cmd.state` as the window's, a set from another window reaching `useStorage`, and
// the migration run before the first render (kept: the widget renders; thrown: it shows why
// and the host hears `migrated` with ok false).

import { describe, expect, expectTypeOf, it } from "vitest";
import { render, createHost } from "@cmd/widget-api/testing";
import { cmd, useStorage, useStoredState, Button, Text, View } from "@cmd/widget-api";

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

describe("their types (tsc)", () => {
  it("widen an initial literal, and keep a type given", () => {
    type Show = "all" | "busy";
    const typed = () => {
      expectTypeOf(useStorage("package", "n", 0)[0]).toEqualTypeOf<number>();
      expectTypeOf(useStorage("package", "s", "all")[0]).toEqualTypeOf<string>();
      expectTypeOf(useStorage("package", "b", false)[0]).toEqualTypeOf<boolean>();
      expectTypeOf(useStorage("package", "l", [1, 2])[0]).toEqualTypeOf<number[]>();
      expectTypeOf(useStorage<string[]>("package", "e", [])[0]).toEqualTypeOf<string[]>();
      expectTypeOf(useStorage<Show>("window", "show", "all")[0]).toEqualTypeOf<Show>();
      expectTypeOf(useStoredState("n", 0)[0]).toEqualTypeOf<number>();
      expectTypeOf(useStoredState<Show>("show", "busy")[0]).toEqualTypeOf<Show>();
      const [, setN] = useStorage("package", "n", 0);
      setN((n) => n + 1);
      // @ts-expect-error a value outside the type given
      useStorage<Show>("window", "show", "nope");
    };
    void typed;
  });
});

describe("migrations", () => {
  it("run for each place listed, before the first render, with cmd.storage", async () => {
    const seen: unknown[] = [];
    cmd.storage.migrate(async ({ scope, from, to }) => {
      seen.push([scope, from, to]);
      const notes = await cmd.storage[scope].get<string>("notes");
      await cmd.storage[scope].set("notes", notes ? notes.split(",") : []);
    });
    function Notes() {
      const [notes] = useStorage<string[]>("package", "notes", []);
      const [mine] = useStorage<string[]>("window", "notes", []);
      return <Text>{[...notes, ...mine].join(" / ")}</Text>;
    }
    const host = createHost({ storage: { package: { notes: "a,b" }, window: { notes: "c" }, migrate: [{ scope: "package", from: 1, to: 2 }, { scope: "window", from: 1, to: 2 }] } });
    const tree = await render(<Notes />, host);
    expect(seen).toEqual([["package", 1, 2], ["window", 1, 2]]);
    expect(host.migrated).toEqual([{ scope: "package", ok: true }, { scope: "window", ok: true }]);
    expect(tree.text()).toBe("a / b / c");
  });

  it("that throw show why instead of the widget, and stop there", async () => {
    cmd.storage.migrate(({ scope }) => {
      if (scope === "workspace") throw new Error("notes isn't a list");
    });
    const host = createHost({ storage: { migrate: [{ scope: "package", from: 2, to: 3 }, { scope: "workspace", from: 2, to: 3 }, { scope: "window", from: 2, to: 3 }] } });
    const tree = await render(<Text>hello</Text>, host);
    expect(host.migrated).toEqual([{ scope: "package", ok: true }, { scope: "workspace", ok: false, message: "notes isn't a list" }]);
    expect(tree.text()).not.toContain("hello");
    expect(tree.text()).toContain("Couldn't update this widget's stored data: notes isn't a list. Its data is as it was.");
  });
});
