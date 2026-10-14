// A Magic window (docs/56, "Magic on V3"): a request in, a widget package out, the window
// becoming its widget in place (windows/package/), or a command to run. Empty, the window asks
// (an AiField, examples under it). While the agent builds, its current step shows (every tool
// call too with magic.showSteps) with Stop; a package asking for permissions shows Allow…; a
// Mac without Deno is asked once whether to download it. A build that ended with a command
// offers to open it in a terminal.

import { AiField, Button, Callout, CodeBlock, Inline, LinkButton, List, ListRow, ListRowContent, ListRowEnd, ListRowIcon, Spinner, Stack, StatusLine, Text, View, ViewState, type ViewStateSpec, WebStage } from "@cmd/ui";
import { useEffect, useRef, useState } from "react";
import type { AppWindow, MagicState, MagicStep } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { copy, typeInTerminal } from "../../lib/actions.ts";
import { resetMagic, useMagicLive, type MagicLive } from "./magic.ts";
import { useStoreValue } from "../../lib/store.ts";
import { editTitle, registerWindowActions, setWindowStatus } from "../../lib/windowActions.ts";
import { useAiStatus } from "../../ai/status.ts";
import { showSetup, useSetup } from "../../onboarding/Onboarding.tsx";

const EXAMPLES = ["show my VPN connection status", "weather in Lisbon this week", "how full is my disk", "my open pull requests on GitHub", "a 25 minute focus timer"];

export function MagicView({ win, focused }: { win: AppWindow; focused: boolean }) {
  const s = win.state as MagicState;
  const live = useMagicLive(win.id);
  const working = s.phase === "working";
  const showSteps = useStoreValue((x) => x.settings.settings["magic.showSteps"]);

  useEffect(() => {
    setWindowStatus(win.id, working ? { label: live.verifying ? "Checking…" : "Working…", key: "working" } : null);
  }, [win.id, working, live.verifying]);
  useEffect(() => () => setWindowStatus(win.id, null), [win.id]);

  const run = (prompt: string) => {
    resetMagic(win.id);
    void cmd.call("magic.run", { id: win.id, prompt }).catch((e: Error) => console.error("magic.run", e));
  };

  // Change (title-bar input) and Stop: the window's menu and the Widgets menu (⌘L, ⌘.) route here.
  const stop = () => void cmd.call("magic.cancel", { id: win.id });
  const latest = useRef({ ready: s.phase === "ready", working, run });
  latest.current = { ready: s.phase === "ready", working, run };
  useEffect(
    () =>
      registerWindowActions(win.id, {
        change: () => latest.current.ready && editTitle(win.id, { placeholder: "Change something…", submit: (t) => latest.current.run(t) }),
        stop: () => latest.current.working && void cmd.call("magic.cancel", { id: win.id }),
      }),
    [win.id],
  );
  useEffect(() => {
    if (working) editTitle(win.id, null);
  }, [win.id, working]);
  useEffect(() => () => editTitle(win.id, null), [win.id]);

  if (s.phase === "empty" || (s.phase === "error" && !s.command)) {
    // Edit with Magic on a package's window: what should change (the package keeps its name and windows).
    const change = s.pkg?.editing ? win.title : undefined;
    return <PromptPane focused={focused} error={s.phase === "error" ? s.error : undefined} initial={change ? "" : s.prompt} onSubmit={run} change={change} />;
  }

  const answerRuntime = (yes: boolean) => void (yes ? cmd.call("magic.installRuntime", {}) : cmd.call("magic.skipRuntime", {})).catch((e: Error) => console.error("magic runtime", e));
  const terminal = s.kind === "terminal" && !!s.command;
  return (
    <View
      className="magic"
      scroll={false}
      // While it builds over a command it offered, the command stays; the footer says what's happening.
      footer={working && terminal && <BuildingLine live={live} onStop={stop} />}
    >
      <WebStage cover={working && s.askRuntime ? runtimeRequest(answerRuntime) : null}>
        {terminal ? (
          <TerminalOffer win={win} command={s.command!} />
        ) : working ? (
          <Building live={live} showSteps={showSteps} onStop={stop} onAllow={s.pkg?.asking ? () => void cmd.call("widget.ask", { name: s.pkg!.name }) : undefined} />
        ) : null}
      </WebStage>
      {!working && s.error && (
        <Callout banner="bottom" compact tone="danger">
          {s.error}
        </Callout>
      )}
    </View>
  );
}

// ── empty: the request ──────────────────────────────────

/** The core's error for a run without a provider (ai/service.ts AiNotConfigured): the setup callout says it better. */
const NO_PROVIDER = /^No AI provider is set up/;

function PromptPane({ focused, error, initial, onSubmit, change }: { focused: boolean; error?: string; initial: string; onSubmit: (p: string) => void; change?: string }) {
  const [text, setText] = useState(initial);
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => {
    if (focused) ref.current?.focus();
  }, [focused]);
  // Without a provider, asking opens the AI step; the request runs once it's done.
  const ai = useAiStatus();
  const setup = useSetup();
  const needsAi = !!ai && !ai.ready;
  const [pending, setPending] = useState<string | null>(null);
  useEffect(() => {
    if (!pending || setup) return;
    setPending(null);
    if (ai?.ready) onSubmit(pending);
  }, [pending, setup, ai?.ready]); // eslint-disable-line react-hooks/exhaustive-deps
  const ask = (p: string) => (needsAi ? (showSetup(["ai"]), setPending(p)) : onSubmit(p));
  return <Ask text={text} onText={setText} onAsk={ask} error={error && !NO_PROVIDER.test(error) ? error : undefined} needsAi={needsAi} autoFocus={focused} change={change} />;
}

/** The empty window, drawn: what it's for, the field, the examples (MagicView.story.tsx). */
export function Ask(p: { text: string; onText: (t: string) => void; onAsk: (prompt: string) => void; error?: string; needsAi: boolean; autoFocus?: boolean; change?: string }) {
  return (
    <View
      state={{
        kind: "empty",
        icon: "sparkles",
        title: p.change ? `Change “${p.change}”` : "New Widget",
        text: p.change ? "Say what should change. Its window shows the new version when it's ready." : "Ask for something to keep an eye on: a question, a URL, some JSON, a command.",
        action: (
          <Stack gap={2}>
            <AiField
              size="lg"
              value={p.text}
              onChange={p.onText}
              onSubmit={p.onAsk}
              state={p.error ? "error" : undefined}
              error={p.error}
              placeholder={p.change ? "What should change?" : "What do you want to see?"}
              autoFocus={p.autoFocus}
              aria-label="Ask for a widget"
            />
            {p.needsAi && (
              <Callout
                compact
                tone="accent"
                icon="sparkles"
                actions={
                  <Button size="sm" onClick={() => showSetup(["ai"])}>
                    Set Up AI…
                  </Button>
                }
              >
                An AI model builds widgets. Connect Anthropic or OpenAI first.
              </Callout>
            )}
            <List>
              {(p.change ? [] : EXAMPLES).map((x) => (
                <ListRow
                  key={x}
                  onClick={() => p.onAsk(x)}
                >
                  <ListRowIcon icon="sparkle" />
                  <ListRowContent title={x} />
                </ListRow>
              ))}
            </List>
          </Stack>
        ),
      }}
    />
  );
}

// ── working: the agent's steps ──────────────────────────

/** What the agent is doing, in its own few words (each step's `why`), newest last. */
function messagesOf(live: MagicLive): string[] {
  const out: string[] = [];
  for (const st of live.steps) if (st.why && out.at(-1) !== st.why) out.push(st.why);
  if (live.verifying) out.push("Checking that it works…");
  else if (live.repair) out.push("Fixing what the check found…");
  if (!out.length) out.push("Reading the request…");
  return out;
}

/**
 * A first build: the current step in the middle, Stop, every step under it with magic.showSteps.
 * A package asking for permissions (its step: "Wants to reach api.github.com"): Allow… brings the grants sheet back.
 */
export function Building({ live, showSteps, onStop, onAllow }: { live: MagicLive; showSteps: boolean; onStop?: () => void; onAllow?: () => void }) {
  const current = messagesOf(live).at(-1)!;
  return (
    <Stack gap={0} grow>
      <ViewState
        state={{
          kind: "loading",
          title: (
            <Stack gap={2} align="center">
              <span aria-live="polite">{current}</span>
              <Inline gap={1.5}>
                {onAllow && (
                  <Button size="sm" variant="primary" onClick={onAllow}>
                    Allow…
                  </Button>
                )}
                {onStop && (
                  <Button size="sm" data-tip-key="⌘." onClick={onStop}>
                    Stop
                  </Button>
                )}
              </Inline>
            </Stack>
          ),
        }}
      />
      {showSteps && <StepList live={live} />}
    </Stack>
  );
}

/** Over a widget (a change): the current step and Stop, in the footer. */
function BuildingLine({ live, onStop }: { live: MagicLive; onStop?: () => void }) {
  return (
    <StatusLine
      end={
        onStop && (
          <LinkButton tone="dim" data-tip-key="⌘." onClick={onStop}>
            Stop
          </LinkButton>
        )
      }
    >
      <Inline gap={1.5}>
        <Spinner size={10} />
        <span aria-live="polite">{messagesOf(live).at(-1)}</span>
      </Inline>
    </StatusLine>
  );
}

/** magic.showSteps: every tool call with its command, time and (on click) output. */
export function StepList({ live, steps }: { live?: MagicLive; steps?: MagicStep[] }) {
  return (
    <List>
      {(steps ?? live?.steps ?? []).map((st) => (
        <StepRow key={st.id} step={st} />
      ))}
      {live?.repair && (
        <ListRow>
          <ListRowIcon icon="arrow.triangle.2.circlepath" tone="dim" />
          <ListRowContent title={live.repair} />
        </ListRow>
      )}
    </List>
  );
}

function StepRow({ step }: { step: MagicStep }) {
  const [open, setOpen] = useState(false);
  const light = step.ms === undefined ? "working" : step.isError ? "danger" : "done";
  return (
    <>
      <ListRow onClick={step.output ? () => setOpen(!open) : undefined}>
        <ListRowIcon icon="circle" light={light} />
        <ListRowContent title={step.why} place={step.detail} />
        <ListRowEnd>
          {step.ms !== undefined && (
            <Text size="xs" tone="dim">
              {(step.ms / 1000).toFixed(1)}s
            </Text>
          )}
        </ListRowEnd>
      </ListRow>
      {open && step.output && (
        <Stack pad={1.5}>
          <CodeBlock>{step.output}</CodeBlock>
        </Stack>
      )}
    </>
  );
}

/** The first build on a Mac without Deno asks before downloading it (the core waits for the answer). */
export function runtimeRequest(onAnswer: (yes: boolean) => void): ViewStateSpec {
  return {
    kind: "empty",
    icon: "arrow.down.circle",
    title: "Download Deno?",
    text: "Widgets with live data need it. It's 40 MB, downloaded once.",
    action: (
      <>
        <Button onClick={() => onAnswer(false)}>Not Now</Button>
        <Button variant="primary" onClick={() => onAnswer(true)}>
          Download
        </Button>
      </>
    ),
  };
}

// ── ready: a command to run ─────────────────────────────

export function TerminalOffer({ win, command }: { win: AppWindow; command: string }) {
  const runIt = async () => {
    await typeInTerminal(win.workspaceId, command);
    await cmd.call("window.close", { id: win.id });
  };
  return (
    <ViewState
      state={{
        kind: "empty",
        icon: "terminal",
        title: "A command to run",
        text: "Opens a terminal with it typed in; press Return to run it.",
        action: (
          <Stack gap={2}>
            <CodeBlock>{command}</CodeBlock>
            <Inline gap={1.5}>
              <Button variant="primary" onClick={() => void runIt()}>
                Open in Terminal
              </Button>
              <Button onClick={() => copy(command)}>Copy</Button>
            </Inline>
          </Stack>
        ),
      }}
    />
  );
}

