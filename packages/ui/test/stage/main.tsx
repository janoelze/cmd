// The kit's stories in a plain browser, for tests (docs/48): one variant of a story file in
// src/ on an empty page, as an app window holds it (the kit's styles, a theme, tooltips,
// scrollbars, icons; no bridge). ?story=<file name>&variant=<export>&theme=<id>
// (?story=overlay&variant=Sheets&theme=dark). The UI Workbench shows the same stories in the
// real app; this page is for Chromium in tests (stories.test.ts, dialog.test.ts).
// A test can change the URL in place (history.replaceState, then a "stage:url" event) and
// waits for body[data-ready="<story>/<variant>"] with data-mount set to its mount param.

import { Component, useEffect, useState, type ComponentType, type ReactNode } from "react";
import { createRoot } from "react-dom/client";
import "../../src/ui.css";
import "../../src/themes/builtin.ts";
import { applyTheme, themeFor } from "../../src/themes/registry.ts";
import { installScrollbars, installTooltips } from "../../src/index.ts";

type Module = Record<string, unknown>;
const files = import.meta.glob<Module>("../../src/**/*.story.tsx");
const stories = Object.fromEntries(Object.entries(files).map(([p, load]) => [p.split("/").pop()!.replace(".story.tsx", ""), load]));
const variantsOf = (m: Module) => Object.keys(m).filter((k) => k !== "args" && typeof m[k] === "function");

/** What broke, for the test: render errors (a story that breaks on purpose aside) and failed loads. */
const errors: string[] = [];
const w = window as unknown as { stage: { list: () => Promise<Record<string, string[]>>; errors: string[] } };
w.stage = { list: async () => Object.fromEntries(await Promise.all(Object.entries(stories).map(async ([id, load]) => [id, variantsOf(await load())]))), errors };

installScrollbars();
installTooltips();

const read = () => Object.fromEntries(new URLSearchParams(location.search));

class Catch extends Component<{ children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() {
    return { failed: true };
  }
  override render() {
    return this.state.failed ? <p data-stage-failed>This story stopped working.</p> : this.props.children;
  }
}

function Stage() {
  const [q, setQ] = useState(read);
  const [mod, setMod] = useState<{ id: string; m: Module } | null>(null);
  useEffect(() => {
    const on = () => setQ(read());
    addEventListener("stage:url", on);
    return () => removeEventListener("stage:url", on);
  }, []);
  useEffect(() => {
    const t = themeFor(q.theme ?? "dark");
    if (t) applyTheme(t);
  }, [q.theme]);
  useEffect(() => {
    const load = q.story ? stories[q.story] : undefined;
    if (!load) return void (q.story && errors.push(`no story ${q.story}`));
    void load().then((m) => setMod({ id: q.story!, m }), (e: unknown) => errors.push(`${q.story}: ${String(e)}`));
  }, [q.story]);
  const m = mod && mod.id === q.story ? mod.m : null;
  const name = m ? (q.variant && variantsOf(m).includes(q.variant) ? q.variant : variantsOf(m)[0]) : undefined;
  const View = m && name ? (m[name] as ComponentType) : null;
  useEffect(() => {
    document.body.dataset.ready = View ? `${q.story}/${name}` : "";
    document.body.dataset.mount = q.mount ?? "";
  }, [View, q.story, name, q.mount]);
  return View ? (
    <Catch key={`${q.story}/${name}/${q.mount ?? ""}/${q.theme ?? ""}`}>
      <View />
    </Catch>
  ) : null;
}

const report = (err: unknown) => void (String(err).includes("on purpose") || errors.push(String(err instanceof Error ? (err.stack ?? err.message) : err)));
createRoot(document.getElementById("root")!, { onCaughtError: report, onUncaughtError: report }).render(<Stage />);
