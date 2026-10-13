// The Operator as one feature (docs/51-operator.md; kernel/features.ts): its widget type, its
// methods (OperatorMethods, protocol operator.ts) and its teardown. The service acts through
// the core's own methods (CoreContext.call), gated by TOOL_ACCESS (tools/), and asks the AI
// service for each turn; it is made with the first call, one per core.

import { OPERATOR_TITLE, type OperatorMethods } from "@cmd/protocol";
import type { CoreContext } from "../kernel/context.ts";
import type { Feature } from "../kernel/features.ts";
import type { HandlerSlice } from "../kernel/handlers.ts";
import type { WindowType } from "../windows/types.ts";
import { OperatorService } from "./service.ts";
import { toolsOf } from "../tools/feature.ts";
import { checkName, NAME_SCHEMA, nameInput, nameSystem, type NamerAnswer } from "../agents/namer.ts";

/** The Operator widget: one per workspace is enough, the conversation is the workspace's. */
export const operatorType: WindowType = {
  kind: "operator",
  title: OPERATOR_TITLE,
  icon: "brain",
  role: "widget",
  description: "Ask it to run your workspace: run the tests, start agents on what fails, wait for them and tell you. You watch every step and say yes before it types anything.",
  create: () => ({ state: {}, title: OPERATOR_TITLE }),
  // The title is the conversation's name (OperatorService's named): kept as set.
  update: (state) => ({ state }),
};

const services = new WeakMap<CoreContext, OperatorService>();

/** The core's Operator, made on first use. */
export function operatorOf(core: CoreContext): OperatorService {
  let s = services.get(core);
  if (!s) {
    s = new OperatorService({
      workspace: (id) => core.workspaces.get(id) ?? null,
      call: (m, p) => core.call(m, p as never),
      agent: (r) => core.ai.agent({ ...r, tier: "smart", purpose: "operator" }),
      selfIn: (id) => core.windows.others().find((w) => w.kind === "operator" && w.workspaceId === id)?.id ?? null,
      broadcast: (e) => core.broadcast(e),
      acting: (call) => toolsOf(core).show(call),
      named: (id, name) => {
        for (const w of core.windows.others()) if (w.kind === "operator" && w.workspaceId === id) core.windows.update(w.id, { title: name ?? OPERATOR_TITLE });
      },
      onAgent: (fn) => void core.agents.on("updated", fn),
      onCommandEnd: (fn) => void core.panes.on("osc", (id, ev) => ev.type === "prompt" && ev.mark === "D" && fn(id, ev.exitCode ?? null)),
      onServing: (fn) => void core.actions.on("url", fn),
      notify: (id, n) => {
        const self = core.windows.others().find((w) => w.kind === "operator" && w.workspaceId === id);
        if (self) core.notifications.widget({ windowId: self.id, title: n.title, body: n.body, urgent: n.urgent, muted: false });
        else core.notifications.info(n.title, n.body);
      },
      // A terminal's window is its pane: its tool calls are found with the terminal's other events too.
      record: (e) => core.data.record(e.windowId && core.panes.get(e.windowId) ? { ...e, paneId: e.windowId } : e),
      // Named like agents' sessions (docs/32), in the background on the fast tier; none without AI.
      name: async (turns, project) => {
        if (!core.ai.status().ready) return null;
        const input = nameInput({ current: null, turns: turns.map((t) => ({ at: t.at, prompt: t.prompt, files: [], final: t.final })), others: [], project });
        const r = await core.ai.object<NamerAnswer>({ tier: "fast", purpose: "operator.name", background: true, system: nameSystem(), prompt: input, schema: NAME_SCHEMA as unknown as Record<string, unknown>, effort: "minimal", maxOutputTokens: 300, temperature: 0 });
        const checked = checkName(r.value.name, [], project);
        return checked.problem ? null : checked.name;
      },
      db: core.store.db,
      approvals: toolsOf(core).approvals,
    });
    services.set(core, s);
  }
  return s;
}

export const operatorFeature = {
  id: "operator",
  handlers: (core: CoreContext): HandlerSlice<keyof OperatorMethods> => ({
    "operator.get": (p) => {
      const c = operatorOf(core).get(p.workspaceId);
      // A window opened after the conversation was named (it asks for it as it opens) takes the name.
      if (c.name) for (const w of core.windows.others()) if (w.kind === "operator" && w.workspaceId === p.workspaceId && w.title !== c.name) core.windows.update(w.id, { title: c.name });
      return c;
    },
    "operator.send": (p) => (operatorOf(core).send(p.workspaceId, p.text, p.selected ?? null), null),
    "operator.stop": (p) => (operatorOf(core).stop(p.workspaceId), null),
    "operator.reset": (p) => (operatorOf(core).reset(p.workspaceId), null),
    "operator.history": (p) => operatorOf(core).history(p.workspaceId),
    "operator.open": (p) => (operatorOf(core).open(p.workspaceId, p.id), null),
  }),
  dispose: (core: CoreContext) => services.get(core)?.dispose(),
} satisfies Feature;
