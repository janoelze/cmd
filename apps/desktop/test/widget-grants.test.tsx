// @vitest-environment happy-dom
// The grants sheet's words (windows/package/grants.ts, docs/56 "Capabilities and grants"): each
// kind of permission as the line a person reads, the new ones marked against the grant there is,
// where the package comes from; and the sheet (GrantSheet.tsx) naming the package, Return allowing.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { noPermissions, type WidgetEntry, type WidgetPermissions } from "@cmd/protocol";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { permissionLines, sourceLine } = await import("../src/renderer/src/windows/package/grants.ts");
const { GrantSheet } = await import("../src/renderer/src/windows/package/GrantSheet.tsx");

const perms = (p: Partial<WidgetPermissions>): WidgetPermissions => ({ ...noPermissions(), ...p });
const labels = (p: Partial<WidgetPermissions>) => permissionLines(perms(p)).map((l) => l.label);

describe("what a package asks for, in words", () => {
  it("says each kind of permission as a line", () => {
    expect(labels({ net: ["api.github.com"] })).toEqual(["Reach api.github.com"]);
    expect(labels({ run: ["gh"] })).toEqual(["Run gh"]);
    expect(labels({ read: ["~/Notes"] })).toEqual(["Read ~/Notes"]);
    expect(labels({ workspace: ["read"] })).toEqual(["See the agents, terminals and windows of this workspace"]);
    expect(labels({ workspace: ["read", "all"] })).toEqual(["See the agents, terminals and windows of every workspace"]);
    expect(labels({ events: ["output"] })).toEqual(["Read output events"]);
    expect(labels({ act: ["actions.run"] })).toEqual(["Run Workspace Actions, asking first"]);
    expect(labels({ act: ["agents", "terminals.type", "windows"] })).toEqual(["Start, message and stop agents, asking first", "Open and type in terminals, asking first", "Close windows, asking first"]);
    expect(labels({ ai: ["complete"] })).toEqual(["Use your AI, counts against your usage"]);
    expect(labels({})).toEqual([]);
  });

  it("marks what the grant there is doesn't cover", () => {
    const lines = permissionLines(perms({ net: ["a.example", "b.example"], run: ["gh"] }), perms({ net: ["a.example"], run: ["gh"] }));
    expect(lines.map((l) => [l.label, l.added])).toEqual([["Reach a.example", false], ["Reach b.example", true], ["Run gh", false]]);
    expect(permissionLines(perms({ net: ["a.example"] })).every((l) => !l.added)).toBe(true); // nothing granted: nothing is "new"
  });

  it("says where the package comes from", () => {
    const short = (p: string) => p.replace("/Users/jan", "~");
    expect(sourceLine({ link: "/Users/jan/src/my-widget", dir: "/Users/jan/.cmd/widgets/my-widget" }, short)).toBe("Linked from ~/src/my-widget");
    expect(sourceLine({ dir: "/Users/jan/.cmd/widgets/ci-runs" }, short)).toBe("Installed in ~/.cmd/widgets");
  });
});

describe("the grants sheet", () => {
  let root: Root | null = null;
  afterEach(async () => {
    if (root) await act(async () => root!.unmount());
    root = null;
    document.body.innerHTML = "";
  });

  it("names the package, its version and source, lists each permission, and Allow answers yes", async () => {
    const entry: WidgetEntry = { ref: "pkg:ci-runs/ci", source: "package", kind: "pkg:ci-runs/ci", title: "CI", icon: "checkmark.seal", name: "ci-runs", version: "1.2.0", api: 1, dir: "/x/.cmd/widgets/ci-runs", link: "/x/src/ci-runs", permissions: perms({ net: ["api.github.com"], run: ["gh"] }), ask: { granted: null }, windows: [] };
    const answers: boolean[] = [];
    const el = document.createElement("div");
    document.body.append(el);
    root = createRoot(el);
    await act(async () => root!.render(<GrantSheet entry={entry} onAnswer={(a) => answers.push(a)} />));
    const text = document.body.textContent ?? "";
    expect(text).toContain("Allow “CI” to use these?");
    expect(text).toContain("ci-runs 1.2.0");
    expect(text).toContain("Linked from /x/src/ci-runs");
    expect([...document.querySelectorAll(".ui-approval-list li")].map((li) => li.textContent)).toEqual(["Reach api.github.com", "Run gh"]);
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Allow")!.click());
    await act(async () => [...document.querySelectorAll("button")].find((b) => b.textContent === "Decline")!.click());
    expect(answers).toEqual([true, false]);
  });
});
