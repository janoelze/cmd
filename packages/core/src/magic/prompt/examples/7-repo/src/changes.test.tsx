// The changes widget against the fake host: files grouped by change, the sync in the title
// bar, a clean repository, and a folder without one.

import { describe, expect, it } from "vitest";
import { render, createHost, type HostData } from "@cmd/widget-api/testing";
import busy from "../fixtures/busy.json" with { type: "json" };
import Changes from "./changes.tsx";

describe("Changes", () => {
  it("groups the changed files and says how far from the remote", async () => {
    const host = createHost(busy as HostData);
    const tree = await render(<Changes />, host);
    expect(tree.find("Window").props.status).toBe("main · 2 ahead · 1 behind · 4 changed");
    expect(tree.sections().map((s) => s.props.title)).toEqual(["Changed", "Added", "Deleted"]);
    expect(tree).toHaveRow("total.ts");
    await tree.press(tree.rows()[0]!);
    expect(host.calls).toContainEqual(["windows.open", "/Users/me/src/shop/src/cart/total.ts"]);
  });

  it("says when there's nothing to commit", async () => {
    const tree = await render(<Changes />, createHost({ git: { root: "/r", branch: "main", ahead: 0, behind: 0, files: [] } }));
    expect(tree).toShowState("empty", "Nothing to commit");
  });

  it("says when the workspace has no repository", async () => {
    const tree = await render(<Changes />, createHost({ git: null }));
    expect(tree).toShowState("empty", "Not a git repository");
  });
});
