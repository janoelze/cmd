// The Operator widget (docs/51): the workspace's conversation with the Operator, newest last
// and kept in sight while it streams, its steps as rows (looks folded together, acts with the
// window they're about), a card for each approval it waits for, and the prompt under it. The
// conversation lives in the core: closing this window doesn't stop a turn. `Operator` draws it
// from props (the story shows it with stand-in conversations); `OperatorView` connects it.

import { createContext, useContext, useEffect, useMemo, useRef, useState } from "react";
import { marked } from "marked";
import DOMPurify from "dompurify";
import type { OperatorConversation, OperatorItem, WindowId } from "@cmd/protocol";
import { AiField, Button, Callout, ChatApproval, ChatComposer, ChatLog, ChatMessage, ChatNote, ChatStep, CodeBlock, Stack, Text, ToolbarButton, ToolbarSpacer, View, WindowToolbar, useStickToEnd, type IconName } from "@cmd/ui";
import { showContextMenu } from "../../lib/context.ts";
import { useAiStatus } from "../../ai/status.ts";
import { showSetup } from "../../onboarding/Onboarding.tsx";
import { getState, getWorkspaceView, useStoreValue } from "../../lib/store.ts";
import { ago, fieldsOf, type SidebarRow } from "../../lib/model.ts";
import { durationText, goTo } from "../../lib/widgets.ts";
import { cmd } from "../../lib/bridge.ts";
import type { WindowViewProps } from "../registry.ts";
import { operatorCall, useOperator } from "./operator.ts";

type Tool = Extract<OperatorItem, { kind: "tool" }>;

/** Each tool's icon. */
const ICONS: Record<string, IconName> = {
  look: "eye",
  read: "text-align-left",
  run: "play",
  agent: "user-plus",
  wait: "hourglass",
  type: "keyboard",
  edit: "pencil-simple",
  open: "plus-square",
  close: "x-square",
  focus: "crosshair",
  search: "magnifying-glass",
  events: "clock-counter-clockwise",
};

/** What the conversation shows, in order: messages, single steps, runs of looks folded into one row. */
type Block = { kind: "item"; item: OperatorItem } | { kind: "looks"; items: Tool[] };

function blocks(items: OperatorItem[]): Block[] {
  const out: Block[] = [];
  for (const item of items) {
    const quiet = item.kind === "tool" && !item.acts && item.state !== "waiting";
    const last = out.at(-1);
    if (quiet && last?.kind === "looks") last.items.push(item as Tool);
    else if (quiet) out.push({ kind: "looks", items: [item as Tool] });
    else out.push({ kind: "item", item });
  }
  return out;
}

const markdown = (text: string) => DOMPurify.sanitize(marked.parse(text, { gfm: true, async: false }) as string);

/** What a conversation's rows do and how they name windows: the app's, or a story's stand-ins. */
export interface OperatorWorld {
  /** A window's name as the board shows it; null once it's closed. */
  useName(id: WindowId): string | null;
  goTo(id: WindowId): void;
  answer(itemId: string, allow: boolean, reason?: string, remember?: boolean): Promise<unknown>;
}

const World = createContext<OperatorWorld>({ useName: () => null, goTo: () => {}, answer: async () => {} });

export interface OperatorProps {
  /** null while it loads. */
  conv: OperatorConversation | null;
  needsAi: boolean;
  focused: boolean;
  world: OperatorWorld;
  onSend(text: string): void;
  onStop(): void;
  onNew(): void;
  onPast(): void;
  onGrants(): void;
}

export function Operator(p: OperatorProps) {
  const [draft, setDraft] = useState("");
  const [history, setHistory] = useState<string[]>([]);
  const body = useRef<HTMLDivElement>(null);
  const field = useRef<HTMLTextAreaElement>(null);
  // Selected (Ask Operator…, a click on its title): the cursor goes to the prompt.
  useEffect(() => {
    if (p.focused) field.current?.focus();
  }, [p.focused]);
  const { toEnd } = useStickToEnd(body, [p.conv?.items]);

  const send = (text: string) => {
    if (p.needsAi) return showSetup(["ai"]);
    setDraft("");
    setHistory((h) => [text, ...h.filter((x) => x !== text)].slice(0, 50));
    toEnd();
    p.onSend(text);
  };

  const empty = !!p.conv && !p.conv.items.length;
  return (
    <World.Provider value={p.world}>
      <Stack gap={0} grow>
        <View
          inset
          bodyRef={body}
          toolbar={
            <WindowToolbar label="Operator">
              <ToolbarButton icon="note-pencil" label="New Conversation" disabled={!p.conv?.items.length} onClick={p.onNew} />
              <ToolbarSpacer />
              <ToolbarButton icon="shield-check" label="Remembered Approvals" menu onClick={p.onGrants} />
              <ToolbarButton icon="clock-counter-clockwise" label="Past Conversations" menu onClick={p.onPast} />
            </WindowToolbar>
          }
          state={
            !p.conv
              ? { kind: "loading" }
              : empty
                ? { kind: "empty", icon: "brain", title: "Ask the Operator", text: "It runs this workspace while you watch: tests, agents, dev servers. It asks before it types anything." }
                : null
          }
        >
          {p.conv && <Conversation conv={p.conv} />}
        </View>
        <ChatComposer>
          {p.needsAi && (
            <Callout compact tone="accent" icon="sparkle" actions={<Button size="sm" onClick={() => showSetup(["ai"])}>Set Up AI…</Button>}>
              The Operator needs an AI model. Connect Anthropic or OpenAI first.
            </Callout>
          )}
          <AiField
            ref={field}
            value={draft}
            onChange={setDraft}
            onSubmit={send}
            onStop={p.onStop}
            state={p.conv?.busy ? "thinking" : "idle"}
            history={history}
            placeholder={p.conv?.busy ? "Working…" : "What should I do?"}
            autoFocus={p.focused}
            aria-label="Ask the Operator"
          />
        </ChatComposer>
      </Stack>
    </World.Provider>
  );
}

/** "this": the window selected before the Operator's own, if it is still open in the Operator's workspace. */
function thisWindow(win: { id: WindowId; workspaceId: string }): WindowId | null {
  const s = getState();
  const here = (id: WindowId) => (s.windows.get(id)?.workspaceId ?? s.panes.get(id)?.workspaceId) === win.workspaceId;
  const history = getWorkspaceView<WindowId[]>(win.workspaceId, "selection.history", []);
  return history.find((id) => id !== win.id && here(id)) ?? null;
}

/** A window's name as the board's title bar says it. */
function useBoardName(id: WindowId): string | null {
  return useStoreValue((s) => {
    const pane = s.panes.get(id) ?? null;
    const win = s.windows.get(id) ?? null;
    if (!pane && !win) return null;
    const agent = pane?.agentId ? (s.agents.get(pane.agentId) ?? null) : null;
    return fieldsOf({ key: id, pane, win, agent, children: [], urgent: agent } as SidebarRow, undefined, 0).name;
  });
}

export function OperatorView({ win, focused }: WindowViewProps) {
  const ws = win.workspaceId;
  const conv = useOperator(ws);
  const ai = useAiStatus();
  const world = useMemo<OperatorWorld>(() => ({ useName: useBoardName, goTo: (id) => goTo(id, ws), answer: (itemId, allow, reason, remember) => operatorCall.answer(ws, itemId, allow, reason, remember) }), [ws]);
  return (
    <Operator
      conv={conv}
      needsAi={!!ai && !ai.ready}
      focused={focused}
      world={world}
      onSend={(text) => void operatorCall.send(ws, text, thisWindow(win)).catch(() => {})}
      onStop={() => void operatorCall.stop(ws)}
      onNew={() => void operatorCall.reset(ws).catch(() => {})}
      onPast={() => void showPast(ws)}
      onGrants={() => void showGrants(ws)}
    />
  );
}

/** Past conversations, newest first: picking one goes back to it (the current one is put away). */
async function showPast(workspaceId: string): Promise<void> {
  const past = await cmd.call("operator.history", { workspaceId }).catch(() => []);
  const now = Date.now();
  await showContextMenu(
    past.length
      ? past.slice(0, 30).map((p) => ({ label: `${p.title.length > 60 ? p.title.slice(0, 59) + "…" : p.title}  ·  ${ago(p.at, now)}`, run: () => void operatorCall.open(workspaceId, p.id).catch(() => {}) }))
      : [{ label: "No past conversations yet", run: () => {}, enabled: false }],
  );
}

/** A run of steps (tool calls, news) stays together; messages stand apart from it. */
const isStep = (b: Block) => b.kind === "looks" || b.item.kind === "tool" || b.item.kind === "event";

/** What the person allowed for good in this workspace: picking one forgets it, so it asks again. */
async function showGrants(workspaceId: string): Promise<void> {
  const grants = await cmd.call("approvals.list", { workspaceId }).catch(() => []);
  await showContextMenu(
    grants.length
      ? [{ label: "Choose one to ask again", run: () => {}, enabled: false }, "-", ...grants.map((g) => ({ label: `Allowed: ${g.label}`, run: () => void cmd.call("approvals.forget", { workspaceId, key: g.key }).catch(() => {}) }))]
      : [{ label: "Nothing allowed for good here yet", run: () => {}, enabled: false }],
  );
}

function Conversation({ conv }: { conv: OperatorConversation }) {
  const shown = useMemo(() => blocks(conv.items), [conv.items]);
  const lastText = [...conv.items].reverse().find((i) => i.kind === "text")?.id;
  const draw = (b: Block, i: number) =>
    b.kind === "looks" ? <Looks key={b.items[0]!.id} items={b.items} /> : <Item key={b.item.id} item={b.item} streaming={conv.busy && b.item.id === lastText && i === shown.length - 1} />;
  const groups: { key: string; steps: boolean; at: number[] }[] = [];
  shown.forEach((b, i) => {
    const last = groups.at(-1);
    if (isStep(b) && last?.steps) last.at.push(i);
    else groups.push({ key: b.kind === "looks" ? b.items[0]!.id : b.item.id, steps: isStep(b), at: [i] });
  });
  return (
    <ChatLog>
      {groups.map((g) =>
        g.steps ? (
          <Stack key={g.key} gap={0}>
            {g.at.map((i) => draw(shown[i]!, i))}
          </Stack>
        ) : (
          draw(shown[g.at[0]!]!, g.at[0]!)
        ),
      )}
    </ChatLog>
  );
}

function Item({ item, streaming }: { item: OperatorItem; streaming: boolean }) {
  switch (item.kind) {
    case "user":
      return (
        <ChatMessage from="person" copy={item.text}>
          {item.text}
        </ChatMessage>
      );
    case "text":
      return (
        <ChatMessage from="agent" streaming={streaming} copy={item.text}>
          <div dangerouslySetInnerHTML={{ __html: markdown(item.text) }} />
        </ChatMessage>
      );
    case "event":
      return <ChatStep icon="bell" title={item.text} state="done" />;
    case "error":
      return <ChatNote tone={item.text === "Stopped." ? undefined : "danger"}>{item.text}</ChatNote>;
    case "tool":
      return item.state === "waiting" && item.ask ? <Approval item={item} /> : <Step item={item} />;
  }
}

function Step({ item, quiet }: { item: Tool; quiet?: boolean }) {
  const world = useContext(World);
  const input = Object.keys(item.input).length ? JSON.stringify(item.input, null, 2) : null;
  return (
    <ChatStep
      icon={ICONS[item.tool] ?? "gear"}
      title={item.why}
      state={item.state}
      quiet={quiet}
      target={item.target ? <WindowName id={item.target} /> : undefined}
      onTarget={item.target ? () => world.goTo(item.target!) : undefined}
      time={item.ms !== undefined ? durationText(item.ms) : undefined}
    >
      {(input || item.output || item.ask) && (
        <>
          {item.remembered ? <Text size="sm">Ran without asking: you allow {item.remembered} here.</Text> : item.ask && <Text size="sm">Asked: {item.ask}</Text>}
          {item.exact && <CodeBlock>{item.exact}</CodeBlock>}
          {input && <CodeBlock>{input}</CodeBlock>}
          {item.output && <CodeBlock tone={item.state === "failed" ? "danger" : undefined}>{item.output}</CodeBlock>}
        </>
      )}
    </ChatStep>
  );
}

/** The window a step is about, by its name on the board (the Operator's refs are for its tools). */
function WindowName({ id }: { id: WindowId }) {
  const name = useContext(World).useName(id);
  return <>{name ?? "Closed window"}</>;
}

function Looks({ items }: { items: Tool[] }) {
  const [open, setOpen] = useState(false);
  if (items.length === 1) return <Step item={items[0]!} quiet />;
  const running = items.some((i) => i.state === "running");
  const failed = items.some((i) => i.state === "failed");
  return (
    <Stack gap={0}>
      <ChatStep icon="eye" quiet title={open ? `${items.length} looks` : (items.find((i) => i.state === "running") ?? items.at(-1)!).why} state={running ? "running" : failed ? "failed" : "done"} time={open ? undefined : `${items.length} steps`}>
        <Stack gap={0}>
          {!open && (
            <Button size="sm" variant="ghost" onClick={() => setOpen(true)}>
              Show Each Step
            </Button>
          )}
          {open && items.map((i) => <Step key={i.id} item={i} quiet />)}
        </Stack>
      </ChatStep>
    </Stack>
  );
}

function Approval({ item }: { item: Tool }) {
  const world = useContext(World);
  const [busy, setBusy] = useState(false);
  return (
    <ChatApproval
      title={item.ask}
      exact={item.exact}
      always={item.offer}
      busy={busy}
      onAnswer={(allow, reason, remember) => {
        setBusy(true);
        void world.answer(item.id, allow, reason, remember).catch(() => setBusy(false));
      }}
    />
  );
}
