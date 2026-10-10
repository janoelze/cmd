// Test hook for e2e/smoke.mjs: window.__cmdBreakView(id, true) makes that window's
// view throw while rendering, so the test can check its ErrorBoundary (WindowContent)
// and that the rest of the app stays live; (id, false) fixes it again. Not installed
// in a packaged app (its pages load from app.asar), where nothing is ever broken.

import { createElement, useSyncExternalStore, type ReactElement } from "react";

const broken = new Set<string>();
const listeners = new Set<() => void>();

if (!location.href.includes("/app.asar/"))
  (window as unknown as { __cmdBreakView?: (id: string, on: boolean) => void }).__cmdBreakView = (id, on) => {
    if (on) broken.add(id);
    else broken.delete(id);
    for (const fn of listeners) fn();
  };

const subscribe = (fn: () => void) => (listeners.add(fn), () => void listeners.delete(fn));

/** This window's view was broken by the test hook. */
export function useBrokenView(id: string): boolean {
  return useSyncExternalStore(subscribe, () => broken.has(id));
}

function Broken(): ReactElement {
  throw new Error("Window view broken on purpose (e2e)");
}

/** What a broken view renders: a component that throws. */
export const brokenView = (): ReactElement => createElement(Broken);
