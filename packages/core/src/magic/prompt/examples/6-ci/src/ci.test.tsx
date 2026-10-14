// The CI widget against the fake host: the runs from the fixture, a failure notified once,
// a click opening the run, Rerun typing gh's command in a terminal, and a repository GitHub doesn't know.

import { describe, expect, it } from "vitest";
import { render, createHost, type HostData } from "@cmd/widget-api/testing";
import failing from "../fixtures/failing.json" with { type: "json" };
import Ci from "./ci.tsx";

describe("CI", () => {
  it("lists the runs with the latest in the title bar", async () => {
    const tree = await render(<Ci />, createHost(failing as HostData));
    expect(tree.find("Window").props.status).toBe("Running · Deploy on main");
    expect(tree).toHaveSection("acme/shop", { count: 3 });
    expect(tree).toHaveRow("Tests");
  });

  it("notifies each workflow's newest failure once, and opens a run on click", async () => {
    const host = createHost(failing as HostData);
    const tree = await render(<Ci />, host);
    expect(host.calls.filter((c) => c[0] === "notify.send")).toEqual([["notify.send", expect.objectContaining({ key: "ci-failed-202", title: "Tests failed" })]]);
    await tree.press(tree.rows()[1]!);
    expect(host.calls).toContainEqual(["windows.open", "https://github.com/acme/shop/actions/runs/202"]);
  });

  it("reruns a failed run's jobs in a terminal, typed for the person to run", async () => {
    const host = createHost(failing as HostData);
    const tree = await render(<Ci />, host);
    await tree.choose(tree.rows()[1]!, "Rerun Failed Jobs");
    expect(host.calls).toContainEqual(["terminals.open", { command: "gh run rerun 202 --failed -R acme/shop" }]);
  });

  it("says when the repository isn't there", async () => {
    const host = createHost({ config: { repo: "acme/gone" }, fetch: { "https://api.github.com/repos/acme/gone/actions/runs?per_page=20": { status: 404 } } });
    const tree = await render(<Ci />, host);
    expect(tree).toShowState("error", "No runs");
  });
});
