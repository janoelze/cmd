// __TITLE__ against a fake cmd (@cmd/widget-api/testing): no app, no browser. `createHost`
// serves fixture terminals and records what the widget does in `host.calls`; `render`
// returns the tree the app would draw. Run with `npm test` or `cmd widget test`.

import { describe, expect, it } from "vitest";
import { render, createHost, fixtures } from "@cmd/widget-api/testing";
import Terminals, { visible } from "./widget.tsx";

const { pane } = fixtures;
const terminals = [pane({ title: "zsh" }), pane({ title: "dev server", command: "pnpm dev", cwd: "/Users/me/src/api" }), pane({ title: "tests", command: "pnpm test" })];

describe("__TITLE__", () => {
  it("lists busy terminals first, with the count in the title bar", async () => {
    const tree = await render(<Terminals />, createHost({ terminals }));
    expect(tree.rows()).toHaveLength(3);
    expect(tree.rows()[0]).toHaveTitle("dev server");
    expect(tree).toHaveRow("zsh");
    expect(tree.find("Window").props.status).toBe("2 running");
  });

  it("filters by the search text and the choice", async () => {
    const tree = await render(<Terminals />, createHost({ terminals }));
    await tree.change(tree.find("ToolbarSearchField"), "api");
    expect(tree.rows()).toHaveLength(1);
    expect(tree.rows()[0]).toHaveTitle("dev server");
    await tree.change(tree.find("ToolbarSearchField"), "");
    await tree.change(tree.find("ToolbarSegmented"), "busy");
    expect(tree).not.toHaveRow("zsh");
  });

  it("selects a terminal's window when its row is pressed", async () => {
    const host = createHost({ terminals });
    const tree = await render(<Terminals />, host);
    await tree.press(tree.rows()[0]!);
    expect(host.calls).toEqual([["windows.select", "w-dev-server"]]);
  });

  it("shows each folder unless the config says not to", async () => {
    const shown = await render(<Terminals />, createHost({ terminals, config: { showFolders: true } }));
    expect(shown.rows()[0]!.children[1]!).toMatchObject({ props: { place: "api" } });
    shown.unmount();
    const hidden = await render(<Terminals />, createHost({ terminals, config: { showFolders: false } }));
    expect(hidden.rows()[0]!.children[1]!).not.toMatchObject({ props: { place: "api" } });
  });

  it("says so when there are no terminals, and when nothing matches", async () => {
    expect(await render(<Terminals />, createHost())).toShowState("empty", "No terminals here");
    const tree = await render(<Terminals />, createHost({ terminals, state: { query: "nothing like it" } }));
    expect(tree).toShowState("noResults", "No matches");
    await tree.choose(tree.find("View"), "Show All");
    expect(tree.rows()).toHaveLength(3);
  });

  it("sorts and filters as a plain function", () => {
    expect(visible(terminals, "", "busy").map((t) => t.title)).toEqual(["dev server", "tests"]);
  });
});
