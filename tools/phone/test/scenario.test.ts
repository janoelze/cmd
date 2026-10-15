// Scenarios: every shipped one loads and is well formed, and a bad one says what's wrong.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { loadScenario, problems, scenarioContext, scenarioNames } from "../src/scenario.ts";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "phone-scenario-"));
afterAll(() => fs.rmSync(home, { recursive: true, force: true }));

describe("scenarios", () => {
  it("ships default", () => expect(scenarioNames()).toContain("default"));

  it.each(scenarioNames())("%s loads", async (name) => {
    const s = await loadScenario(name, await scenarioContext(home));
    expect(problems(s)).toEqual([]);
    expect(s.workspaces.flatMap((w) => w.panes).length).toBeGreaterThan(0);
  });

  it("default has a shell, Claude needing you, working and done, and its stand-ins", async () => {
    const ctx = await scenarioContext(home);
    const s = await loadScenario("default", ctx);
    const panes = s.workspaces.flatMap((w) => w.panes);
    expect(panes.some((p) => !p.command)).toBe(true);
    const events = panes.flatMap((p) => p.agent?.hooks?.map(([e]) => e) ?? []);
    expect(events).toEqual(expect.arrayContaining(["PermissionRequest", "PreToolUse", "Stop"]));
    for (const p of panes.filter((p) => p.agent)) expect(p.command).toMatch(/\/claude --demo=\w+$/);
    // Each stand-in is run as `claude`/`htop`, so cmd detects it by name.
    for (const bin of ["claude", "htop"]) expect(fs.statSync(path.join(ctx.bin, bin)).mode & 0o111).toBeTruthy();
  });

  it("says what's wrong with one", async () => {
    expect(problems(null)).toEqual(["It isn't an object."]);
    expect(problems({ description: "x", workspaces: [] })).toEqual(["workspaces: at least one."]);
    expect(problems({ workspaces: [{ name: "a b", panes: [{ name: "", env: { A: 1 } }] }] })).toEqual([
      "description: a line saying what it shows.",
      "workspaces[0].name: a folder name, or null for Home.",
      "workspaces[0].panes[0].name: what it is.",
      "workspaces[0].panes[0].env: strings only.",
    ]);
    await expect(loadScenario("no-such", await scenarioContext(home))).rejects.toThrow("There's no scenario “no-such”. There are: default");
  });

  it("a stand-in session that doesn't exist says which do", async () => {
    const ctx = await scenarioContext(home);
    expect(() => ctx.claude("nope", home)).toThrow("fake-claude has no “nope” session");
  });
});

describe("forgetReplaced", () => {
  it("keeps one pairing per core: a core under a new host key gives up its old one", async () => {
    const { forgetReplaced } = await import("../src/state.ts");
    const file = path.join(home, "pairings.json");
    expect(forgetReplaced("scenario:default", "A", file)).toBeNull();
    expect(forgetReplaced("scenario:default", "A", file)).toBeNull(); // restarts: same key
    expect(forgetReplaced("dev:/w1", "S", file)).toBeNull();
    expect(forgetReplaced("scenario:default", "B", file)).toBe("A"); // its folder was deleted
    expect(forgetReplaced("dev:/w1", "S", file)).toBeNull();
  });
});
