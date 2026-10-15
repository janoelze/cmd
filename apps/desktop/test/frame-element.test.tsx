// @vitest-environment happy-dom
// The Frame element in the package view (windows/package/FrameElement.tsx, API 1.2): where no
// page can be drawn (a preview, a story) its label stands in at the Frame's height, or the
// least a Frame is tall without one; a page that isn't in the package says so in place, naming
// the file, instead of drawing blank.
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TreeNode, WireValue } from "@cmd/protocol";

// Anything else the view reads of the bridge answers never.
vi.mock("../src/renderer/src/lib/bridge.ts", () => ({ cmd: new Proxy({ onEvent: () => () => {}, releasePackageFrame: () => {} } as Record<string, unknown>, { get: (t, k: string) => t[k] ?? (() => new Promise(() => {})) }) }));
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

const { PackageWidget } = await import("../src/renderer/src/windows/package/PackageView.tsx");
const { TreeStore } = await import("../src/renderer/src/windows/package/tree.ts");
type Frames = import("../src/renderer/src/windows/package/FrameElement.tsx").Frames;

let root: Root | null = null;
afterEach(async () => {
  if (root) await act(async () => root!.unmount());
  root = null;
  document.body.innerHTML = "";
});

const quiet = { interact: () => {}, resync: () => {}, restart: () => {}, ask: () => {}, env: () => {} };
const frameTree = (props: Record<string, WireValue>): TreeNode[] => [{ id: 1, type: "View", props: {}, children: [{ id: 2, type: "Frame", props: { label: "Runs per hour", ...props }, children: [] }] }];

async function draw(nodes: TreeNode[], frames: Frames | null): Promise<HTMLElement> {
  const store = new TreeStore({ resync: () => {} });
  store.apply({ kind: "tree", rev: 1, nodes });
  const el = document.createElement("div");
  document.body.append(el);
  root = createRoot(el);
  await act(async () => root!.render(<PackageWidget windowId="w-1" store={store} link={quiet} frames={frames ? () => frames : null} />));
  return el;
}

describe("a Frame element", () => {
  it("stands in with its label at its height where no page is drawn, or the least a Frame is tall", async () => {
    let el = await draw(frameTree({ src: "chart.html", height: 180 }), null);
    const box = el.querySelector(".ui-empty")!.parentElement as HTMLElement;
    expect(el.textContent).toContain("Runs per hour");
    expect(box.style.height).toBe("180px");
    await act(async () => root!.unmount());
    el = await draw(frameTree({ src: "chart.html" }), null);
    expect((el.querySelector(".ui-empty")!.parentElement as HTMLElement).style.minHeight).toBe("var(--frame-min-h)");
  });

  it("says in place that its page isn't in the package, naming the file", async () => {
    const frames: Frames = {
      windowId: "w-1",
      serve: () => Promise.reject(new Error("Error invoking remote method 'package-frame': Error: meter.html isn't in this package")),
      reloadKey: "k",
      active: true,
      kv: {},
      config: {},
    };
    const el = await draw(frameTree({ src: "meter.html" }), frames);
    await act(async () => new Promise((r) => setTimeout(r, 0)));
    expect(el.querySelector(".ui-callout")?.textContent).toContain("meter.html isn't in this package");
    expect(el.querySelector("iframe")).toBeNull();
  });
});
