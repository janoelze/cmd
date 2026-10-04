// A Magic widget's edit view (docs/14-magic-v2.md), ⌘E from its widget:
//  - Changes: ask for a change, and every version so far (what was asked, a
//    screenshot, whether its checks passed), any of which can be brought back.
//  - Settings: how often the data runs, the widget's own settings (from its
//    manifest: a city, a repository, a token), and what its data.ts may touch.
//  - Files: the widget's folder; files open in cmd, and edits made anywhere
//    (by hand, by Claude Code) show up in the widget as a new version.
//  - Health: is the data coming, why not, what the last build's checks left,
//    how it was made (the agent's steps), and what widgets run on.

import { useEffect, useRef, useState, type ReactNode } from "react";
import type { AppWindow, MagicConfigField, MagicRuntime, MagicState, MagicWidgetInfo } from "@cmd/protocol";
import {
  Badge,
  Button,
  ButtonGroup,
  Callout,
  CodeBlock,
  EmptyState,
  FormRow,
  FormSection,
  KeyValue,
  LinkButton,
  NumberField,
  ResetButton,
  SecretField,
  Select,
  Spacer,
  Spinner,
  StatusDot,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Toolbar,
  type TabItem,
} from "@cmd/ui";
import { cmd } from "../bridge.ts";
import { copy, openPath } from "../actions.ts";
import { intervalLabel, refreshChoices, type MagicLive } from "../magic.ts";
import { ago } from "../model.ts";
import { StepList } from "./MagicView.tsx";

type Tab = "changes" | "settings" | "files" | "health";
const TABS: TabItem<Tab>[] = [
  { id: "changes", label: "Changes" },
  { id: "settings", label: "Settings" },
  { id: "files", label: "Files" },
  { id: "health", label: "Health" },
];

const fileUrl = (p: string) => `cmd-file://local/?path=${encodeURIComponent(p)}`;

export function MagicEditor({ win, live, onRun, onClose }: { win: AppWindow; live: MagicLive; onRun: (prompt: string) => void; onClose: () => void }) {
  const s = win.state as MagicState;
  const [tab, setTab] = useState<Tab>(s.health && !s.health.ok ? "health" : "changes");
  const [info, setInfo] = useState<MagicWidgetInfo | null>(null);
  const working = s.phase === "working";
  // Asked again whenever the window changes (a new version, a hand edit, new config).
  useEffect(() => {
    let alive = true;
    void cmd.call("magic.widget", { id: win.id }).then((i) => alive && setInfo(i), () => alive && setInfo(null));
    return () => void (alive = false);
  }, [win.id, s.revision, win.updatedAt]);
  const healthBad = !!(s.health && !s.health.ok) || !!s.problems?.length || !!s.error;

  return (
    <div className="magic-edit">
      <Toolbar label="Widget editor">
        <Tabs value={tab} onChange={setTab} label="Editor" items={TABS.map((t) => (t.id === "health" && healthBad ? { ...t, badge: "dot", tone: "danger" } : t))} />
        <Spacer />
        {working && (
          <span className="magic-working">
            <Spinner size={11} /> Working…
          </span>
        )}
        <Button size="sm" onClick={onClose} data-tip="Back to the widget" data-tip-key="⌘E">
          Done
        </Button>
      </Toolbar>
      <div className="magic-edit-body">
        {tab === "changes" && <Changes win={win} info={info} working={working} onRun={onRun} />}
        {tab === "settings" && <Settings win={win} info={info} />}
        {tab === "files" && <Files info={info} />}
        {tab === "health" && <Health win={win} live={live} />}
      </div>
    </div>
  );
}

const Dim = ({ children }: { children: ReactNode }) => <div className="magic-note">{children}</div>;

// ── Changes ─────────────────────────────────────────────

function Changes({ win, info, working, onRun }: { win: AppWindow; info: MagicWidgetInfo | null; working: boolean; onRun: (p: string) => void }) {
  const s = win.state as MagicState;
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const submit = () => {
    if (!text.trim() || working) return;
    onRun(text.trim());
    setText("");
  };
  const revisions = [...(info?.revisions ?? [])].reverse();
  return (
    <>
      <FormSection title="Change it" plain>
        <TextArea
          ref={ref}
          rows={3}
          autoGrow={10}
          placeholder={working ? "Wait for the current change to finish…" : "What should change? “bigger numbers”, “add humidity”, “show the last 7 days”"}
          value={text}
          disabled={working}
          onChange={setText}
          onSubmit={submit}
          submitOnEnter
        />
        <div className="magic-actions">
          <span className="magic-note">⏎ to send · the widget stays as it is until the change works</span>
          <Spacer />
          <Button disabled={working} onClick={() => void cmd.call("magic.fix", { id: win.id })}>
            Check and Fix
          </Button>
          <Button variant="primary" disabled={working || !text.trim()} onClick={submit}>
            Change
          </Button>
        </div>
      </FormSection>
      <FormSection title="Versions" aside={info?.edited ? "files edited since the last version" : undefined} plain>
        {!revisions.length && <EmptyState compact icon="clock.arrow.circlepath" title="No versions yet" />}
        <ol className="magic-revisions">
          {revisions.map((r) => {
            const current = r.n === s.revision;
            return (
              <li key={r.n} className={`magic-revision${current ? " current" : ""}`}>
                {r.shot ? <img className="magic-shot" src={fileUrl(r.shot)} alt="" loading="lazy" /> : <div className="magic-shot none" />}
                <div className="magic-revision-text">
                  <div className="magic-revision-prompt" data-tip={r.prompt}>
                    {r.prompt}
                  </div>
                  <div className="magic-note">
                    <StatusDot size="sm" state={r.ok ? "success" : "warning"} /> {r.ok ? "checks passed" : `${r.problems?.length ?? "some"} problem${r.problems?.length === 1 ? "" : "s"} left`} ·{" "}
                    {ago(r.at, Date.now())}
                    {r.model ? ` · ${r.model}` : ""} · v{r.n}
                  </div>
                </div>
                {current ? (
                  <Badge>shown</Badge>
                ) : (
                  <Button size="sm" disabled={working} onClick={() => void cmd.call("magic.restore", { id: win.id, revision: r.n })}>
                    Restore
                  </Button>
                )}
              </li>
            );
          })}
        </ol>
      </FormSection>
      {(s.history?.length ?? 0) > 0 && (
        <FormSection title="Asked so far" plain>
          <ol className="magic-history">
            {s.history!.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ol>
        </FormSection>
      )}
    </>
  );
}

// ── Settings ────────────────────────────────────────────

function Settings({ win, info }: { win: AppWindow; info: MagicWidgetInfo | null }) {
  const s = win.state as MagicState;
  const m = info?.manifest;
  const hasData = !!(s.hasData || s.source);
  const cur = s.refresh ?? 0;
  const setRefresh = (seconds: number) => void cmd.call("magic.setRefresh", { id: win.id, seconds });
  return (
    <>
      {hasData && (
        <FormSection title="Data">
          <FormRow
            title="Refresh"
            description="How often its data runs."
            accessory={s.refreshByUser && m && m.refresh !== cur && <ResetButton label={`Use the widget's (${intervalLabel(m.refresh)})`} onClick={() => setRefresh(m.refresh)} />}
          >
            <Select
              value={String(cur)}
              options={refreshChoices(cur).map(String)}
              labels={Object.fromEntries(refreshChoices(cur).map((c) => [String(c), c === 0 ? "Never" : `Every ${intervalLabel(c).replace(/^1 /, "")}`]))}
              onChange={(v) => setRefresh(Number(v))}
            />
          </FormRow>
        </FormSection>
      )}
      {m && m.config.length > 0 && (
        <FormSection title="Widget settings">
          {m.config.map((f) => (f.secret ? <SecretRow key={f.key} win={win} field={f} set={!!info?.secrets[f.key]} /> : <ConfigRow key={f.key} win={win} field={f} value={s.config?.[f.key]} />))}
        </FormSection>
      )}
      {m && (
        <FormSection title="What its data may use">
          <FormRow title="Permissions" description="Always read-only: it can't change files or run anything else, whatever its code does." stacked>
            <KeyValue
              mono
              items={[
                ["Websites", m.permissions.net.length ? m.permissions.net.join(", ") : "none"],
                ["Programs", m.permissions.run.length ? m.permissions.run.join(", ") : "none"],
                ...(m.permissions.env.length ? [["Environment", m.permissions.env.join(", ")] as const] : []),
                ...(m.permissions.read.length ? [["Folders", m.permissions.read.join(", ")] as const] : []),
              ]}
            />
          </FormRow>
        </FormSection>
      )}
      {!m && (
        <Callout tone={s.widgetId ? "warning" : "neutral"}>
          {s.widgetId ? "The widget's manifest.json has a problem (see Health)." : "Made before widgets had settings: change it once to rebuild it as a widget."}
        </Callout>
      )}
    </>
  );
}

function ConfigRow({ win, field, value }: { win: AppWindow; field: MagicConfigField; value: unknown }) {
  const shown = value ?? field.default;
  const commit = (v: unknown) => void cmd.call("magic.config", { id: win.id, values: { [field.key]: v } });
  let control: ReactNode;
  if (field.type === "boolean") control = <Switch checked={!!shown} onChange={commit} label={field.title} />;
  else if (field.type === "enum") control = <Select value={String(shown ?? "")} options={field.options ?? []} onChange={commit} />;
  else if (field.type === "number" && typeof shown === "number") control = <NumberField value={shown} onChange={commit} />;
  else
    control = (
      <TextField
        value={shown === undefined ? "" : String(shown)}
        inputMode={field.type === "number" ? "decimal" : undefined}
        placeholder={field.default === undefined ? "" : String(field.default)}
        onCommit={(t) => commit(field.type === "number" ? (t.trim() === "" ? null : Number(t)) : t)}
      />
    );
  return (
    <FormRow
      title={field.title}
      tip={field.key}
      description={field.description}
      accessory={value !== undefined && value !== field.default && <ResetButton onClick={() => commit(null)} />}
    >
      {control}
    </FormRow>
  );
}

function SecretRow({ win, field, set }: { win: AppWindow; field: MagicConfigField; set: boolean }) {
  return (
    <FormRow title={field.title} tip={field.key} description={field.description ?? "Kept by cmd outside the widget; only its data.ts gets it."}>
      <SecretField set={set} onSave={(v) => void cmd.call("magic.secret", { id: win.id, key: field.key, value: v })} />
    </FormRow>
  );
}

// ── Files ───────────────────────────────────────────────

const FILE_NOTES: Record<string, string> = {
  "manifest.json": "title, size, refresh, permissions, settings",
  "data.ts": "gets the data (Deno), checked against its schema",
  "view.html": "the markup and its styles",
  "view.ts": "draws the data",
  "static.json": "data that doesn't change",
};

function Files({ info }: { info: MagicWidgetInfo | null }) {
  if (!info) return <EmptyState compact icon="folder" title="No widget folder yet">Change it once to rebuild it as a widget.</EmptyState>;
  return (
    <>
      <FormSection
        title="Files"
        aside={
          <ButtonGroup>
            <LinkButton onClick={() => cmd.revealPath(info.dir)}>Show in Finder</LinkButton>
            <LinkButton onClick={() => copy(info.dir)}>Copy Path</LinkButton>
          </ButtonGroup>
        }
      >
        {info.files.map((f) => (
          <FormRow
            key={f}
            compact
            title={<span className="magic-file">{f}</span>}
            description={FILE_NOTES[f] ?? (f.startsWith("fixtures/") ? (f === "fixtures/live.json" ? "the data from the last check" : "test data the view must handle") : undefined)}
          >
            <Button size="sm" onClick={() => void openPath(`${info.dir}/${f}`)}>
              Open
            </Button>
          </FormRow>
        ))}
      </FormSection>
      <Dim>
        Edit them in cmd or anywhere else (Claude Code too: <code>cmd widget check {info.dir}</code> runs the same checks). Saved changes show up in the widget and become a new version.
      </Dim>
    </>
  );
}

// ── Health ──────────────────────────────────────────────

function Health({ win, live }: { win: AppWindow; live: MagicLive }) {
  const s = win.state as MagicState;
  const [rt, setRt] = useState<MagicRuntime | null>(null);
  const [installing, setInstalling] = useState<string | null>(null);
  useEffect(() => {
    void cmd.call("magic.runtime", {}).then(setRt, () => {});
  }, []);
  const install = () => {
    setInstalling("Downloading Deno…");
    cmd.call("magic.installRuntime", {}).then(
      (r) => (setRt(r), setInstalling(null)),
      (e: Error) => setInstalling(e.message),
    );
  };
  const h = s.health;
  const hasData = !!(s.hasData || s.source);
  const now = Date.now();
  const broken = h?.ok === false || !!s.problems?.length || !!s.error;
  const fix = (
    <Button size="sm" variant="primary" disabled={s.phase === "working"} onClick={() => void cmd.call("magic.fix", { id: win.id })} data-tip="The agent gets the error and the widget's files.">
      Fix It
    </Button>
  );
  return (
    <>
      <FormSection title="Data" aside={hasData && <LinkButton onClick={() => void cmd.call("magic.refresh", { id: win.id })}>Refresh Now</LinkButton>} plain>
        {!hasData ? (
          <Callout>This widget has no data to fetch.</Callout>
        ) : !h ? (
          <Callout>Not run yet.</Callout>
        ) : h.ok ? (
          <Callout tone="success">Coming in{h.lastOk ? `, last ${ago(live.data?.at ?? h.lastOk, now)}` : ""}.</Callout>
        ) : (
          <>
            <Callout tone="danger" title={`Failing${h.failures > 1 ? ` (${h.failures} times in a row)` : ""}`} actions={fix}>
              {h.lastOk ? `Last good data ${ago(h.lastOk, now)}. ` : ""}
              {h.retryAt && h.retryAt > now ? `Next try in ${Math.ceil((h.retryAt - now) / 1000)} s. ` : ""}
              {h.permission && "It needs something its manifest doesn't allow: Fix lets the agent add it."}
            </Callout>
            {h.error && <CodeBlock tone="danger">{h.error}</CodeBlock>}
          </>
        )}
      </FormSection>
      {(s.problems?.length || s.error) && (
        <FormSection title="Problems" aside={h?.ok !== false && broken && fix} plain>
          <div className="magic-stack">
            {s.error && <CodeBlock tone="danger">{s.error}</CodeBlock>}
            {s.problems?.map((p, i) => (
              <CodeBlock key={i}>{p}</CodeBlock>
            ))}
          </div>
        </FormSection>
      )}
      {s.summary && (
        <FormSection title="Last change" plain>
          <div>{s.summary}</div>
        </FormSection>
      )}
      {(live.running ? live.steps : s.steps)?.length ? (
        <FormSection title="How it was made" plain>
          <StepList steps={live.running ? live.steps : s.steps} live={live.running ? live : undefined} className="magic-steps-inline" />
        </FormSection>
      ) : null}
      <FormSection title="Runtime">
        <FormRow title="Deno" description={rt ? (rt.deno ? `${rt.version ?? "?"} · ${rt.deno}` : "Not installed.") : "…"} note={installing}>
          {rt && !rt.deno && (
            <Button size="sm" busy={!!installing && installing.startsWith("Downloading")} onClick={install}>
              Install
            </Button>
          )}
        </FormRow>
        <FormRow title="Sandbox" description={rt ? (rt.sandbox ? "sandbox-exec" : "Unavailable: data.ts runs only with CMD_MAGIC_UNSANDBOXED=1.") : "…"}>
          {rt && <StatusDot state={rt.sandbox ? "success" : "warning"} />}
        </FormRow>
        <FormRow title="Previews" description={rt ? (rt.previewer ?? "none") : "…"} />
      </FormSection>
    </>
  );
}
