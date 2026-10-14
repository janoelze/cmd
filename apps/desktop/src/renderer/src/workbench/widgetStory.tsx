// Widget packages' stories in the UI Workbench (docs/56, "Stories in the Workbench"): a
// package's src/<widget>.story.tsx exports its widget as the default and one variant per
// state, each the fake host's data (`HostData` of @cmd/widget-api/testing/host). Here each
// variant becomes a component: the widget runs in the widget runtime against createHost(data)
// until it is idle, one at a time (the runtime holds one connection per process), and the
// tree it sent is drawn by the package view in a window at a reference size, with the title
// bar its Window fills; `Sizes` draws the first state at every reference size (narrow,
// regular, wide). The config the widget gets is its fields' defaults under the state's, as
// the core gives it. A still: the widget stops once its tree is taken. The packages are
// cmd's own (packages/widgets) and the person's (~/.cmd/widgets, linked ones too: catalog/).

import { useEffect, useMemo, useState, type ComponentType } from "react";
import { Window as Frame, WindowBar, WindowBarMenu, WindowBody, WindowFrame } from "@cmd/ui";
import type { WidgetOut } from "@cmd/protocol";
import { run, type WidgetModule } from "@cmd/widget-api/runtime";
import { createHost, type HostData } from "@cmd/widget-api/testing/host";
import { AllSizes, SIZES, type SizeName } from "../reference/RefWindow.tsx";
import { useWindowStatus } from "../lib/windowActions.ts";
import { showContextMenu } from "../lib/context.ts";
import { useWindowChrome } from "../windows/registry.ts";
import { chromeOf, menuEntries, menuLabel } from "../windows/package/chrome.ts";
import { PackageWidget } from "../windows/package/PackageView.tsx";
import type { WidgetLink } from "../windows/package/live.ts";
import { TreeStore } from "../windows/package/tree.ts";

/** What a variant may say besides the host's data: the window's reference size. */
export type WidgetVariant = HostData & { size?: SizeName };

interface PackageJson {
  name: string;
  version: string;
  cmd?: { widgets?: { id: string; title?: string; icon?: string; main?: string; config?: { key: string; default?: unknown; secret?: boolean }[] }[] };
}

let queue: Promise<unknown> = Promise.resolve();
const tick = () => new Promise<void>((r) => setTimeout(r, 0));

/** The widget's tree and patches against a fake host with `data`, once it is idle; runs after any other still in progress. */
function still(widget: WidgetModule, data: HostData, info: { package: string; version: string; widget: string }): Promise<WidgetOut[]> {
  const next = queue.then(async () => {
    const host = createHost(data);
    const sent: WidgetOut[] = [];
    const transport = { send: (m: WidgetOut) => (sent.push(m), host.transport.send(m)), listen: host.transport.listen };
    const r = await run(transport, widget, info);
    // Idle: nothing in flight, nothing new sent, for two turns of the event loop.
    for (let i = 0, quiet = 0, last = -1; i < 500 && quiet < 2; i++) {
      await tick();
      const now = sent.length + r.connection.busy;
      quiet = host.inFlight === 0 && now === last ? quiet + 1 : 0;
      last = now;
    }
    const tree = sent.slice();
    r.stop();
    return tree;
  });
  queue = next.catch(() => {});
  return next;
}

let windows = 0;
const quiet: WidgetLink = { interact: () => {}, resync: () => {}, restart: () => {}, env: () => {}, ask: () => {} };

function Bar({ id, name, icon }: { id: string; name: string; icon: string }) {
  useWindowChrome();
  const status = useWindowStatus(id);
  const c = chromeOf(id);
  return (
    <WindowBar icon={icon} name={name}>
      <span className="ui-window-bar-meta">{status?.label}</span>
      {c?.menu?.length ? <WindowBarMenu onClick={() => void showContextMenu(menuEntries(c.menu, c.send))}>{menuLabel(c.menu)}</WindowBarMenu> : null}
    </WindowBar>
  );
}

/** One variant: the widget's window at its size, drawn from the still. */
function Variant({ widget, data, pkg, id: widgetId, name, icon, size }: { widget: WidgetModule; data: WidgetVariant; pkg: PackageJson; id: string; name: string; icon: string; size?: SizeName }) {
  const id = useMemo(() => `story-package-${++windows}`, []);
  const [store] = useState(() => new TreeStore({ resync: () => {} }));
  useEffect(() => {
    let live = true;
    const { size: _size, ...host } = data;
    // Config as the core gives it: the fields' defaults under what the state sets.
    const fields = pkg.cmd?.widgets?.find((w) => w.id === widgetId)?.config ?? [];
    const defaults = Object.fromEntries(fields.filter((f) => !f.secret && f.default !== undefined).map((f) => [f.key, f.default]));
    void still(widget, { ...host, config: { ...defaults, ...(host.config ?? {}) } as HostData["config"] }, { package: pkg.name, version: pkg.version, widget: widgetId }).then((messages) => {
      if (live) for (const m of messages) if (m.kind === "tree" || m.kind === "patch") store.apply(m);
    });
    return () => void (live = false);
  }, [widget, data, pkg, widgetId, store]);
  const [width, height] = SIZES[size ?? data.size ?? "regular"];
  return (
    <Frame selected style={{ width, height, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <Bar id={id} name={name} icon={icon} />
        <div style={{ flex: 1, minHeight: 0, display: "flex", flexDirection: "column" }}>
          <PackageWidget windowId={id} store={store} link={quiet} />
        </div>
      </WindowBody>
      <WindowFrame />
    </Frame>
  );
}

/** A widget package's story module as the Workbench's: each variant (a WidgetVariant) a component. `base`: the story file's name, the widget's `main` without .tsx. */
export function widgetStory(mod: Record<string, unknown>, pkg: PackageJson, base: string): Record<string, ComponentType> {
  const widgets = pkg.cmd?.widgets ?? [];
  const w = widgets.find((x) => x.main?.replace(/^\.?\/?src\//, "").replace(/\.tsx?$/, "") === base) ?? widgets[0];
  const widget = mod.default as WidgetModule;
  const out: Record<string, ComponentType> = {};
  const props = { widget, pkg, id: w?.id ?? base, name: w?.title ?? pkg.name, icon: w?.icon ?? "puzzlepiece.extension" };
  let first: WidgetVariant | undefined;
  for (const [name, data] of Object.entries(mod)) {
    if (name === "default" || !data || typeof data !== "object") continue;
    first ??= data as WidgetVariant;
    const V = () => <Variant {...props} data={data as WidgetVariant} />;
    V.displayName = name;
    out[name] = V;
  }
  // The first state in the reference size matrix (narrow, regular, wide), as the reference windows' Sizes.
  if (first) {
    const data = first;
    const Sizes = () => <AllSizes render={(size) => <Variant {...props} data={data} size={size} />} />;
    Sizes.displayName = "Sizes";
    out.Sizes = Sizes;
  }
  return out;
}
