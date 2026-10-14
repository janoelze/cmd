// Frame widgets (docs/56, "The frame surface, for pixels"): a package widget with
// `"surface": "frame"` draws its view.html in the app's one frame host (renderer lib/frames.ts,
// served by main's cmd-widget://package/). The core says what the frame may load (its package
// folder, the hosts its grant reaches: frameSource) and serves its few calls (frameCall) through
// an API adapter of its own window, the same verbs and access table as its process's: the
// window's state, and windows.open of an http(s) URL only with `pressed`, which the app sets
// after its own check of a press in the frame. A frame never gets a secret or any other verb.

import fs from "node:fs";
import { FRAME_VERBS, type WindowId, type WireValue } from "@cmd/protocol";
import type { CoreContext } from "../../kernel/context.ts";
import { invalid } from "../api/access.ts";
import { AiUsage } from "../api/ai.ts";
import { apiV1 } from "../api/v1.ts";
import { effective, needsGrant } from "../grants.ts";
import type { PackageWidget, WidgetPackage } from "../package.ts";

type FrameCore = Pick<CoreContext, "windows" | "library" | "agents" | "panes" | "windowTypes" | "workspaces" | "data" | "actions" | "notifications" | "ai" | "settings" | "broadcast" | "opened">;

/** The frame widget a window shows, with its grant; null for any other window, or one waiting for its grant. */
function frameOf(core: FrameCore, windowId: WindowId): { pkg: WidgetPackage; widget: PackageWidget; net: string[]; permissions: ReturnType<typeof effective> } | null {
  const w = core.windows.others().find((x) => x.id === windowId);
  const pkg = w ? core.library.packages.forKind(w.kind) : null;
  const widget = pkg?.widgets.find((x) => x.kind === w!.kind);
  if (!pkg || !widget || widget.surface !== "frame") return null;
  const g = core.library.host.granted(pkg.name);
  if (needsGrant(pkg.permissions, g?.permissions)) return null;
  const permissions = effective(pkg.permissions, g?.permissions);
  return { pkg, widget, net: permissions.net, permissions };
}

export function frameSource(core: FrameCore, windowId: WindowId): { dir: string; media: string[] } | null {
  const f = frameOf(core, windowId);
  if (!f) return null;
  let dir = f.pkg.dir;
  try {
    dir = fs.realpathSync(dir);
  } catch {}
  return { dir, media: f.net };
}

export async function frameCall(core: FrameCore, windowId: WindowId, verb: string, params: unknown, pressed: boolean): Promise<WireValue> {
  const f = frameOf(core, windowId);
  if (!f) throw new Error(`not a frame widget's window: ${windowId}`);
  if (!(FRAME_VERBS as readonly string[]).includes(verb)) throw invalid(`A frame can't call ${String(verb).slice(0, 60)}.`);
  const args = (Array.isArray(params) ? params : []) as WireValue[];
  if (verb === "windows.open" && !(typeof args[0] === "string" && /^https?:\/\//i.test(args[0]))) throw invalid("A frame opens http(s) links only.");
  const at = pressed ? Date.now() : 0;
  const adapter = apiV1(core, {
    windowId,
    workspaceId: () => core.windows.others().find((w) => w.id === windowId)?.workspaceId ?? "",
    pkg: f.pkg,
    widget: f.widget,
    permissions: f.permissions,
    pressedAt: () => at,
    secret: () => null,
    aiUsage: new AiUsage(null),
  });
  return adapter.call(verb, args);
}
