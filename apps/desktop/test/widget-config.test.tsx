// @vitest-environment happy-dom
// A package widget's Configure sheet (windows/package/ConfigSheet.tsx, docs/56 "Configuring a
// package widget"): a row per field with the control its type asks for and the default as
// placeholder; Save sends only what changed (widget.config) and each typed or removed secret
// (widget.secret); a stored secret shows Set, never its value, and a typed one is a password
// field; "Set up" shows while a needed field is missing and nothing is set.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { WidgetConfigField, WidgetEntry } from "@cmd/protocol";

vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({}, { get: () => () => new Promise(() => {}) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { ConfigSheet, needsSetup } = await import("../src/renderer/src/windows/package/ConfigSheet.tsx");
type Api = import("../src/renderer/src/windows/package/ConfigSheet.tsx").ConfigApi;

const SECRET = "ghp_never_shown_9c1d";
const FIELDS: WidgetConfigField[] = [
  { key: "repo", title: "Repository", type: "string", description: "owner/name" },
  { key: "limit", title: "Runs", type: "number", default: 10 },
  { key: "failedOnly", title: "Only failures", type: "boolean", default: false },
  { key: "branch", title: "Branch", type: "enum", options: ["main", "dev"], default: "main" },
  { key: "token", title: "Token", type: "string", secret: true, host: "api.github.com" },
];
const entry = (secrets: string[] = [], config = FIELDS): WidgetEntry & { config: WidgetConfigField[] } => ({ ref: "pkg:ci/ci", source: "package", kind: "pkg:ci/ci", title: "CI", icon: "checkmark.seal", windows: [], config, secrets });

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

function api(set: string[] = []) {
  return { config: vi.fn(async () => null), secret: vi.fn(async () => null), secrets: vi.fn(async () => set) } satisfies Api;
}

async function draw(e: ReturnType<typeof entry>, config: Record<string, unknown> | undefined, a: Api, onClose = vi.fn()) {
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<ConfigSheet entry={e} config={config} onClose={onClose} api={a} />));
  return onClose;
}

const dialog = () => document.querySelector(".ui-dialog") as HTMLElement;
const row = (title: string) => [...dialog().querySelectorAll(".ui-row")].find((r) => r.querySelector(".ui-row-name")?.textContent === title) as HTMLElement;
const button = (label: string, within: HTMLElement = dialog()) => [...within.querySelectorAll("button")].find((b) => b.textContent?.trim() === label) as HTMLButtonElement;
async function type(input: HTMLInputElement, text: string) {
  const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!;
  await act(async () => {
    set.call(input, text);
    input.dispatchEvent(new Event("input", { bubbles: true }));
  });
}
const click = (b: HTMLElement) => act(async () => b.click());

describe("the Configure sheet", () => {
  it("draws a row per field, the control by type, defaults as placeholders, and where a secret goes", async () => {
    await draw(entry(), undefined, api());
    expect([...dialog().querySelectorAll(".ui-row-name")].map((n) => n.textContent)).toEqual(["Repository", "Runs", "Only failures", "Branch", "Token"]);
    expect(row("Repository").querySelector("input")!.placeholder).toBe("");
    expect(row("Repository").textContent).toContain("owner/name");
    expect(row("Runs").querySelector("input")!.placeholder).toBe("10");
    expect(row("Only failures").querySelector("[role=switch], input[type=checkbox]")).not.toBeNull();
    expect((row("Branch").querySelector("select") as HTMLSelectElement).value).toBe("main");
    const token = row("Token");
    expect(token.querySelector("input")!.type).toBe("password");
    expect(token.querySelector("input")!.placeholder).toBe("Not set");
    expect(token.textContent).toContain("Sent only to api.github.com");
  });

  it("Save sends what changed and the typed secret, then closes", async () => {
    const a = api();
    const onClose = await draw(entry(), { branch: "main" }, a);
    await type(row("Repository").querySelector("input")!, "jan/cmd");
    await type(row("Runs").querySelector("input")!, "25");
    await act(async () => {
      const s = row("Branch").querySelector("select")!;
      s.value = "dev";
      s.dispatchEvent(new Event("change", { bubbles: true }));
    });
    await type(row("Token").querySelector("input")!, ` ${SECRET} `);
    expect(row("Token").querySelector("input")!.type).toBe("password");
    await click(button("Save"));
    expect(a.config).toHaveBeenCalledWith({ repo: "jan/cmd", limit: 25, branch: "dev" });
    expect(a.secret).toHaveBeenCalledWith("token", SECRET);
    expect(onClose).toHaveBeenCalled();
  });

  it("sends nothing for what didn't change, and says why a save failed", async () => {
    const a = api();
    a.config.mockRejectedValueOnce(new Error("Runs: \"x\" isn't a number"));
    const onClose = await draw(entry([]), { repo: "jan/cmd" }, a);
    await click(button("Save"));
    expect(a.config).not.toHaveBeenCalled();
    expect(a.secret).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledTimes(1);
    await type(row("Runs").querySelector("input")!, "x");
    await click(button("Save"));
    expect(dialog().textContent).toContain("Couldn't save these settings");
    expect(dialog().textContent).toContain("isn't a number");
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("shows a stored secret as Set, never its value; Change types a new one, Remove removes it", async () => {
    const a = api(["token"]);
    await draw(entry(["token"]), { repo: "jan/cmd" }, a);
    const token = row("Token");
    expect(token.textContent).toContain("Set");
    expect(token.querySelector("input")).toBeNull();
    expect(document.body.innerHTML).not.toContain(SECRET);
    await click(button("Change", token));
    expect(row("Token").querySelector("input")!.type).toBe("password");
    expect(row("Token").querySelector("input")!.value).toBe("");
    await click(button("Cancel", row("Token")));
    await click(button("Remove", row("Token")));
    expect(row("Token").textContent).toContain("Removed when you save");
    await click(button("Save"));
    expect(a.secret).toHaveBeenCalledWith("token", null);
  });
});

describe("Set up", () => {
  it("shows while nothing is set and a needed field is missing", () => {
    expect(needsSetup(entry(), undefined)).toBe(true);
    expect(needsSetup(entry(["token"]), undefined)).toBe(false);
    expect(needsSetup(entry(), { repo: "jan/cmd" })).toBe(false);
    // Only fields with defaults: it runs as it is.
    expect(needsSetup(entry([], FIELDS.slice(1, 4)), undefined)).toBe(false);
    expect(needsSetup(entry([], []), undefined)).toBe(false);
    expect(needsSetup(undefined, undefined)).toBe(false);
  });
});
