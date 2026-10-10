// @vitest-environment happy-dom
// ErrorBoundary: a child that throws shows the fallback, onError gets the error
// and component stack, and Reload mounts the child again.
import { createElement as h, act } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ErrorBoundary } from "../src/boundary.tsx";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

let mounts = 0;
let broken = true;
function Flaky() {
  mounts++;
  if (broken) throw new Error("view broke");
  return h("p", { id: "ok" }, "fine");
}

afterEach(() => {
  document.body.innerHTML = "";
  mounts = 0;
  broken = true;
});

describe("ErrorBoundary", () => {
  it("shows the fallback, reports the error with the component stack, and remounts on Reload", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const onError = vi.fn();
    const root = createRoot(el, { onCaughtError: () => {} });
    await act(async () => root.render(h(ErrorBoundary, { onError }, h(Flaky))));

    expect(el.textContent).toContain("This window stopped working");
    expect(el.querySelector("#ok")).toBeNull();
    expect(onError).toHaveBeenCalledTimes(1);
    const [error, info] = onError.mock.calls[0]!;
    expect((error as Error).message).toBe("view broke");
    expect(info.componentStack).toMatch(/Flaky/);

    broken = false;
    const before = mounts;
    const reload = [...el.querySelectorAll("button")].find((b) => b.textContent?.includes("Reload Window"))!;
    await act(async () => reload.click());
    expect(mounts).toBeGreaterThan(before);
    expect(el.querySelector("#ok")?.textContent).toBe("fine");
    expect(el.textContent).not.toContain("stopped working");
    await act(async () => root.unmount());
  });

  it("calls onReload instead of remounting when given", async () => {
    const el = document.createElement("div");
    document.body.append(el);
    const onReload = vi.fn();
    const root = createRoot(el, { onCaughtError: () => {} });
    await act(async () => root.render(h(ErrorBoundary, { onReload, reloadLabel: "Reload" }, h(Flaky))));
    broken = false;
    await act(async () => el.querySelector("button")!.click());
    expect(onReload).toHaveBeenCalledTimes(1);
    expect(el.textContent).toContain("stopped working");
    await act(async () => root.unmount());
  });
});
