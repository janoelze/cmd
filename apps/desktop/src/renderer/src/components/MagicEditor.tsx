// A Magic window's edit view (docs/14-magic-v2.md), ⌘E from its widget:
//  - Changes: ask for a change, and every version so far (what was asked, a
//    screenshot, whether its checks passed), any of which can be brought back.
//  - Settings: how often the data runs, the widget's own settings (from its
//    manifest: a city, a repository, a token), and what its data.ts may touch.
//  - Files: the widget's folder; files open in cmd, and edits made anywhere
//    (by hand, by Claude Code) show up in the widget as a new version.
//  - Health: is the data coming, why not, what the last build's checks left,
//    how it was made (the agent's steps), and what widgets run on.

import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from "react";
import type { AppWindow, MagicConfigField, MagicRuntime, MagicState, MagicWidgetInfo } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { copy, openPath } from "../actions.ts";
import { intervalLabel, refreshChoices, type MagicLive } from "../magic.ts";
import { ago } from "../model.ts";
import { StepList } from "./MagicView.tsx";

type Tab = "changes" | "settings" | "files" | "health";
const TABS: { id: Tab; label: string }[] = [
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
      <div className="magic-edit-bar">
        <div className="magic-tabs" role="tablist">
          {TABS.map((t) => (
            <button key={t.id} role="tab" aria-selected={tab === t.id} className={`magic-tab${tab === t.id ? " on" : ""}`} onClick={() => setTab(t.id)}>
              {t.label}
              {t.id === "health" && healthBad && <span className="k-dot magic-tab-dot" />}
            </button>
          ))}
        </div>
        <span className="magic-spacer" />
        {working && <span className="magic-dim">Working…</span>}
        <button className="btn" onClick={onClose} data-tip="Back to the widget" data-tip-key="⌘E">
          Done
        </button>
      </div>
      <div className="magic-edit-body">
        {tab === "changes" && <Changes win={win} info={info} working={working} onRun={onRun} />}
        {tab === "settings" && <Settings win={win} info={info} />}
        {tab === "files" && <Files info={info} />}
        {tab === "health" && <Health win={win} live={live} />}
      </div>
    </div>
  );
}

function Section({ title, children, right }: { title: string; children: ReactNode; right?: ReactNode }) {
  return (
    <section className="magic-section">
      <div className="magic-section-title">
        <span>{title}</span>
        {right}
      </div>
      {children}
    </section>
  );
}

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
  const onKey = (e: KeyboardEvent) => {
    if (e.key === "Enter" && !e.shiftKey) {
      e.preventDefault();
      submit();
    }
  };
  const revisions = [...(info?.revisions ?? [])].reverse();
  return (
    <>
      <Section title="Change it">
        <textarea
          ref={ref}
          className="magic-edit-input"
          rows={3}
          placeholder={working ? "Wait for the current change to finish…" : "What should change? “bigger numbers”, “add humidity”, “show the last 7 days”"}
          value={text}
          disabled={working}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKey}
          spellCheck={false}
        />
        <div className="magic-row magic-row-end">
          <span className="magic-dim magic-small">⏎ to send · the widget stays as it is until the change works</span>
          <span className="magic-spacer" />
          <button className="btn" disabled={working} onClick={() => void cmd.call("magic.fix", { id: win.id })}>
            Check and Fix
          </button>
          <button className="btn primary" disabled={working || !text.trim()} onClick={submit}>
            Change
          </button>
        </div>
      </Section>
      <Section title="Versions" right={info?.edited ? <span className="magic-dim magic-small">files edited since the last version</span> : undefined}>
        {!revisions.length && <div className="magic-dim">No versions yet.</div>}
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
                  <div className="magic-dim magic-small">
                    <span className={`k-dot ${r.ok ? "k-good" : "k-warn"}`} /> {r.ok ? "checks passed" : `${r.problems?.length ?? "some"} problem${r.problems?.length === 1 ? "" : "s"} left`} · {ago(r.at, Date.now())}
                    {r.model ? ` · ${r.model}` : ""} · v{r.n}
                  </div>
                </div>
                {current ? (
                  <span className="magic-dim magic-small">shown</span>
                ) : (
                  <button className="btn" disabled={working} onClick={() => void cmd.call("magic.restore", { id: win.id, revision: r.n })}>
                    Restore
                  </button>
                )}
              </li>
            );
          })}
        </ol>
      </Section>
      {(s.history?.length ?? 0) > 0 && (
        <Section title="Asked so far">
          <ol className="magic-history">
            {s.history!.map((h, i) => (
              <li key={i}>{h}</li>
            ))}
          </ol>
        </Section>
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
  return (
    <>
      {hasData && (
        <Section title="Refresh">
          <label className="magic-field">
            <span>Run the data every</span>
            <select value={cur} onChange={(e) => void cmd.call("magic.setRefresh", { id: win.id, seconds: Number(e.target.value) })}>
              {refreshChoices(cur).map((c) => (
                <option key={c} value={c}>
                  {intervalLabel(c)}
                </option>
              ))}
            </select>
            {s.refreshByUser && m && m.refresh !== cur && (
              <button className="magic-link" onClick={() => void cmd.call("magic.setRefresh", { id: win.id, seconds: m.refresh })}>
                Use the widget's ({intervalLabel(m.refresh)})
              </button>
            )}
          </label>
        </Section>
      )}
      {m && m.config.length > 0 && (
        <Section title="Widget settings">
          {m.config.map((f) => (f.secret ? <SecretField key={f.key} win={win} field={f} set={!!info?.secrets[f.key]} /> : <ConfigField key={f.key} win={win} field={f} value={s.config?.[f.key]} />))}
        </Section>
      )}
      {m && (
        <Section title="What its data may use">
          <dl className="magic-perms">
            <dt>Websites</dt>
            <dd>{m.permissions.net.length ? m.permissions.net.join(", ") : "none"}</dd>
            <dt>Programs</dt>
            <dd>{m.permissions.run.length ? m.permissions.run.join(", ") : "none"}</dd>
            {m.permissions.env.length > 0 && (
              <>
                <dt>Environment</dt>
                <dd>{m.permissions.env.join(", ")}</dd>
              </>
            )}
            {m.permissions.read.length > 0 && (
              <>
                <dt>Folders</dt>
                <dd>{m.permissions.read.join(", ")}</dd>
              </>
            )}
          </dl>
          <div className="magic-dim magic-small">Always read-only: it can't change files or run anything else, whatever its code does.</div>
        </Section>
      )}
      {!m && <div className="magic-dim">{s.widgetId ? "The widget's manifest.json has a problem (see Health)." : "Made before widgets had settings: change it once to rebuild it as a widget."}</div>}
    </>
  );
}

function ConfigField({ win, field, value }: { win: AppWindow; field: MagicConfigField; value: unknown }) {
  const shown = value ?? field.default;
  const [text, setText] = useState(shown === undefined ? "" : String(shown));
  useEffect(() => setText(shown === undefined ? "" : String(shown)), [shown]);
  const commit = (v: unknown) => void cmd.call("magic.config", { id: win.id, values: { [field.key]: v } });
  const save = () => {
    if (text === String(shown ?? "")) return;
    commit(field.type === "number" ? (text.trim() === "" ? null : Number(text)) : text);
  };
  let control: ReactNode;
  if (field.type === "boolean") control = <input type="checkbox" checked={!!shown} onChange={(e) => commit(e.target.checked)} />;
  else if (field.type === "enum")
    control = (
      <select value={String(shown ?? "")} onChange={(e) => commit(e.target.value)}>
        {(field.options ?? []).map((o) => (
          <option key={o} value={o}>
            {o}
          </option>
        ))}
      </select>
    );
  else
    control = (
      <input
        className="magic-text"
        type={field.type === "number" ? "number" : "text"}
        value={text}
        placeholder={field.default === undefined ? "" : String(field.default)}
        onChange={(e) => setText(e.target.value)}
        onBlur={save}
        onKeyDown={(e) => e.key === "Enter" && save()}
        spellCheck={false}
      />
    );
  return (
    <label className="magic-field">
      <span data-tip={field.description}>{field.title}</span>
      {control}
      {value !== undefined && value !== field.default && (
        <button className="magic-link" onClick={() => commit(null)}>
          Reset
        </button>
      )}
    </label>
  );
}

function SecretField({ win, field, set }: { win: AppWindow; field: MagicConfigField; set: boolean }) {
  const [text, setText] = useState("");
  const save = (v: string | null) => {
    void cmd.call("magic.secret", { id: win.id, key: field.key, value: v });
    setText("");
  };
  return (
    <label className="magic-field">
      <span data-tip={field.description ?? "Kept by cmd outside the widget; only its data.ts gets it."}>{field.title}</span>
      <input className="magic-text" type="password" value={text} placeholder={set ? "•••••••• (set)" : "not set"} onChange={(e) => setText(e.target.value)} onKeyDown={(e) => e.key === "Enter" && text && save(text)} />
      {text ? (
        <button className="magic-link" onClick={() => save(text)}>
          Save
        </button>
      ) : set ? (
        <button className="magic-link" onClick={() => save(null)}>
          Clear
        </button>
      ) : null}
    </label>
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
  if (!info) return <div className="magic-dim">This window has no widget folder yet: change it once to rebuild it as a widget.</div>;
  return (
    <>
      <Section
        title="Files"
        right={
          <span className="magic-row">
            <button className="magic-link" onClick={() => cmd.revealPath(info.dir)}>
              Show in Finder
            </button>
            <button className="magic-link" onClick={() => copy(info.dir)}>
              Copy Path
            </button>
          </span>
        }
      >
        <ul className="magic-files">
          {info.files.map((f) => (
            <li key={f}>
              <button className="magic-file" onClick={() => void openPath(`${info.dir}/${f}`)}>
                {f}
              </button>
              <span className="magic-dim magic-small">{FILE_NOTES[f] ?? (f.startsWith("fixtures/") ? (f === "fixtures/live.json" ? "the data from the last check" : "test data the view must handle") : "")}</span>
            </li>
          ))}
        </ul>
      </Section>
      <div className="magic-dim magic-small">
        Edit them in cmd or anywhere else (Claude Code too: <code>cmd widget check {info.dir}</code> runs the same checks). Saved changes show up in the widget and become a new version.
      </div>
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
  return (
    <>
      <Section
        title="Data"
        right={
          hasData ? (
            <button className="magic-link" onClick={() => void cmd.call("magic.refresh", { id: win.id })}>
              Refresh Now
            </button>
          ) : undefined
        }
      >
        {!hasData ? (
          <div className="magic-dim">This widget has no data to fetch.</div>
        ) : !h ? (
          <div className="magic-dim">Not run yet.</div>
        ) : h.ok ? (
          <div className="magic-row">
            <span className="k-dot k-good" /> Coming in{h.lastOk ? `, last ${ago(live.data?.at ?? h.lastOk, now)}` : ""}.
          </div>
        ) : (
          <div className="magic-stack">
            <div className="magic-row">
              <span className="k-dot k-bad" /> Failing{h.failures > 1 ? ` (${h.failures} times in a row)` : ""}
              {h.lastOk ? `, last good data ${ago(h.lastOk, now)}` : ""}.{h.retryAt && h.retryAt > now ? ` Next try in ${Math.ceil((h.retryAt - now) / 1000)} s.` : ""}
            </div>
            <pre className="magic-pre">{h.error}</pre>
            {h.permission && <div className="magic-dim magic-small">It needs something its manifest doesn't allow: Fix lets the agent add it.</div>}
          </div>
        )}
      </Section>
      {(s.problems?.length || s.error) && (
        <Section title="Problems">
          {s.error && <pre className="magic-pre">{s.error}</pre>}
          {s.problems?.map((p, i) => (
            <pre key={i} className="magic-pre">
              {p}
            </pre>
          ))}
        </Section>
      )}
      {(h?.ok === false || s.problems?.length || s.error) && (
        <div className="magic-row">
          <button className="btn primary" disabled={s.phase === "working"} onClick={() => void cmd.call("magic.fix", { id: win.id })}>
            Fix It
          </button>
          <span className="magic-dim magic-small">The agent gets the error and the widget's files.</span>
        </div>
      )}
      {s.summary && (
        <Section title="Last change">
          <div>{s.summary}</div>
        </Section>
      )}
      {(live.running ? live.steps : s.steps)?.length ? (
        <Section title="How it was made">
          <StepList steps={live.running ? live.steps : s.steps} live={live.running ? live : undefined} className="magic-steps-inline" />
        </Section>
      ) : null}
      <Section title="Runtime">
        {rt ? (
          <dl className="magic-perms">
            <dt>Deno</dt>
            <dd>
              {rt.deno ? `${rt.version ?? "?"} · ${rt.deno}` : "not installed"}
              {!rt.deno && (
                <button className="magic-link" onClick={install} disabled={!!installing}>
                  Install
                </button>
              )}
            </dd>
            <dt>Sandbox</dt>
            <dd>{rt.sandbox ? "sandbox-exec" : "unavailable (data.ts runs only with CMD_MAGIC_UNSANDBOXED=1)"}</dd>
            <dt>Previews</dt>
            <dd>{rt.previewer ?? "none"}</dd>
          </dl>
        ) : (
          <div className="magic-dim">…</div>
        )}
        {installing && <div className="magic-dim magic-small">{installing}</div>}
      </Section>
    </>
  );
}
