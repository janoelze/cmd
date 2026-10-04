// The Settings window: the pages and sections of layout.ts in a sidebar like the
// main window's, each section one list of rows generated from SETTINGS_SCHEMA:
// the title and description on the left, a control chosen from the key's type
// and display hints on the right. The key itself (what `cmd settings set`
// takes) is the title's tooltip. Secrets (API keys, SECRETS) are rows too but
// are stored by the core outside settings.json.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  MAGIC_PROVIDERS,
  SECRETS,
  SETTINGS_SCHEMA,
  isSecretKey,
  settingTitle,
  type MagicModel,
  type MagicProvider,
  type SecretDef,
  type SecretKey,
  type SecretsStatus,
  type SettingDef,
  type SettingKey,
  type SearchStatus,
  type SettingsSnapshot,
} from "@cmd/protocol";
import { COMMANDS, COMMAND_BY_ID, DEFAULT_KEYBINDINGS, norm, prettyAccelerator, type CommandSpec } from "../../../shared/commands.ts";
import { Symbol } from "../components/Symbol.tsx";
import { IndexRing } from "../components/IndexRing.tsx";
import { acceleratorOf, usableShortcut, useKeybindings } from "../keybindings.ts";
import { cmd } from "../bridge.ts";
import { NumberField, Popup, SecretField, Segmented, Switch, TextField } from "./controls.tsx";
import { useSettings } from "./useSettings.ts";
import { About } from "./About.tsx";
import { Remote } from "./Remote.tsx";
import { allThemes } from "../themes/registry.ts";
import { itemKey, itemShown, settingsPages, type Item, type ItemKey, type Page as SettingsPage } from "./layout.ts";

const PAGES: SettingsPage[] = settingsPages();
type Nav = { id: string; title: string; icon: string };
const NAV: Nav[] = [...PAGES, { id: "keyboard", title: "Keyboard Shortcuts", icon: "keyboard" }, { id: "about", title: "About", icon: "info.circle" }];

const APPLIES_NOTE = { newTerminals: "Applies to new terminals.", firstLaunch: "Applies on first launch." } as const;
const COMMAND_GROUPS: Record<string, string> = { app: "App", file: "File", edit: "Edit", view: "View", session: "Sessions", space: "Spaces", help: "Help" };

const PAGE_KEY = "settings.page";
/** Opened at a page (main's openSettings): "remote", or "remote/pair" to show a pairing code. */
const askedPage = new URLSearchParams(location.search).get("page");
function initialPage(): string {
  const asked = askedPage?.split("/")[0];
  if (asked && NAV.some((n) => n.id === asked)) return asked;
  try {
    const p = localStorage.getItem(PAGE_KEY);
    if (p && NAV.some((n) => n.id === p)) return p;
  } catch {}
  return NAV[0]!.id;
}

const textOf = (k: ItemKey): string[] => {
  if (isSecretKey(k)) {
    const d: SecretDef = SECRETS[k];
    return [d.title, d.description, k];
  }
  const d: SettingDef = SETTINGS_SCHEMA[k];
  return [settingTitle(k), d.description, k];
};
const matches = (k: ItemKey, q: string) => textOf(k).some((t) => t.toLowerCase().includes(q));
const shortcutMatches = (c: CommandSpec, q: string) => [c.label, c.id].some((t) => t.toLowerCase().includes(q));

/** A description with `code` spans. */
const prose = (text: string): ReactNode[] => text.split(/`([^`]+)`/).map((t, i) => (i % 2 ? <code key={i}>{t}</code> : t));

/** Enums with a few short labels read best as a segmented control; the rest as a popup. */
function segmented(d: Extract<SettingDef, { type: "enum" }>): boolean {
  const chars = d.options.reduce((n, o) => n + (d.labels?.[o] ?? o).length, 0);
  return d.options.length <= 4 && chars <= 24;
}

/** Everything a row needs from the window: values, and how to change them. */
export interface RowContext {
  snap: SettingsSnapshot;
  secrets: SecretsStatus | null;
  save: (key: SettingKey, value: unknown) => void;
  reset: (key: SettingKey) => void;
  saveSecret: (key: SecretKey, value: string | null) => void;
}

export function SettingsWindow() {
  const { snapshot: snap, connected, search, secrets, remote } = useSettings();
  const [page, setPage] = useState(initialPage);
  /** Bumped by "Pair a Device…": the Remote page shows a pairing code. */
  const [pairAsk, setPairAsk] = useState(askedPage === "remote/pair" ? 1 : 0);
  useEffect(
    () =>
      cmd.onSettingsPage((p) => {
        const [id, sub] = p.split("/");
        if (!NAV.some((n) => n.id === id)) return;
        setQuery("");
        setPage(id!);
        if (sub === "pair") setPairAsk((n) => n + 1);
      }),
    [],
  );
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const input = useRef<HTMLInputElement>(null);
  const q = query.trim().toLowerCase();
  const nav = NAV.find((n) => n.id === page)!;

  useEffect(() => {
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch {}
    document.title = nav.title;
  }, [page, nav.title]);

  const ctx: RowContext = {
    snap,
    secrets,
    save: (key, value) => {
      setError(null);
      cmd.call("settings.set", { key, value }).catch((err: Error) => setError(err.message));
    },
    reset: (key) => void cmd.call("settings.reset", { key }).catch((err: Error) => setError(err.message)),
    saveSecret: (key, value) => void cmd.call("secrets.set", { key, value }).then(() => setError(null), (err: Error) => setError(err.message)),
  };

  // Search covers every row, also ones `when` hides (the other provider's key).
  const hits = useMemo(
    () =>
      q
        ? PAGES.flatMap((p) =>
            p.sections
              .map((s) => ({ page: p, section: s, items: s.items.filter((it) => matches(itemKey(it), q)).map(itemKey) }))
              .filter((r) => r.items.length),
          )
        : [],
    [q],
  );
  const shortcutHits = q ? (COMMANDS as readonly CommandSpec[]).filter((c) => shortcutMatches(c, q)).length : 0;
  const hitPages = new Set([...hits.map((h) => h.page.id), ...(shortcutHits ? ["keyboard"] : [])]);
  const errors = [...snap.errors, ...(error ? [error] : [])];

  let body: ReactNode;
  if (q) {
    body = hits.length || shortcutHits ? (
      <>
        {hits.map((h) => (
          <SectionView key={`${h.page.id}/${h.section.title}`} title={[h.page.title, h.section.title].filter(Boolean).join(" › ")}>
            {h.items.map((k) => (
              <ItemRow key={k} k={k} ctx={ctx} />
            ))}
          </SectionView>
        ))}
        {shortcutHits > 0 && <Shortcuts q={q} />}
      </>
    ) : (
      <div className="sw-empty">No settings match “{query.trim()}”</div>
    );
  } else if (page === "keyboard") {
    body = <Shortcuts />;
  } else if (page === "remote") {
    body = <Remote key={pairAsk} status={remote} enabled={snap.settings["remote.enabled"]} pair={pairAsk > 0} row={(k) => <ItemRow k={k} ctx={ctx} />} />;
  } else if (page === "about") {
    body = <About updates={<ItemRow k="updates.mode" ctx={ctx} />} crashReports={<ItemRow k="diagnostics.crashReports" ctx={ctx} />} usageStats={<ItemRow k="diagnostics.usageStats" ctx={ctx} />} />;
  } else {
    const p = PAGES.find((x) => x.id === page)!;
    const keys = p.sections.flatMap((s) => s.items.map(itemKey)).filter((k): k is SettingKey => !isSecretKey(k));
    const changed = keys.filter((k) => snap.overrides.includes(k));
    body = (
      <>
        {p.sections.map((s, i) => {
          const items = s.items.filter((it: Item) => itemShown(it, snap.settings));
          return (
            <SectionView key={s.title ?? i} title={s.title}>
              {items.map((it) => (
                <ItemRow key={itemKey(it)} k={itemKey(it)} ctx={ctx} />
              ))}
              {s.items.some((it) => itemKey(it) === "search.enabled") && <IndexStatusRow status={search} enabled={snap.settings["search.enabled"]} />}
            </SectionView>
          );
        })}
        <div className="sw-page-foot">
          <button className="sw-button" disabled={!changed.length} onClick={() => changed.forEach(ctx.reset)}>
            Restore Defaults
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="sw" style={{ ["--sidebar-pad" as string]: `${snap.settings["ui.sidebarPadding"]}px` }}>
      <aside className="sidebar sw-side">
        <div className="sidebar-titlebar" />
        <div className="sb-search">
          <Symbol name="magnifyingglass" size={11} className="sb-search-icon" />
          <input
            ref={input}
            value={query}
            placeholder="Search settings"
            spellCheck={false}
            onChange={(e) => (setQuery(e.target.value), setScrolled(false))}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
          {query && (
            <button className="sb-search-clear" aria-label="Clear" data-tip="Clear Search" onClick={() => (setQuery(""), input.current?.focus())}>
              <Symbol name="xmark.circle.fill" size={11} />
            </button>
          )}
        </div>
        <nav className="sidebar-scroll sw-nav">
          {NAV.map((n) => (
            <button
              key={n.id}
              type="button"
              className={`row short sw-nav-item${!q && n.id === page ? " sel" : ""}${q && !hitPages.has(n.id) ? " dim" : ""}`}
              onClick={() => (setQuery(""), setPage(n.id), setScrolled(false))}
            >
              {/* a fixed-size tile: symbols differ in width, the labels should line up */}
              <span className="sw-nav-icon">
                <Symbol name={n.icon} size={13} weight="semibold" />
              </span>
              <span className="sw-nav-label">{n.title}</span>
            </button>
          ))}
        </nav>
        <button className="sw-side-foot" onClick={() => cmd.openSettingsFile(snap.path)} disabled={!snap.path} data-tip={snap.path}>
          <Symbol name="curlybraces" size={11} weight="semibold" />
          Open settings.json
        </button>
      </aside>
      <main className="sw-main">
        <header className={`sw-bar${scrolled ? " scrolled" : ""}`}>
          <h1>{q ? "Search Results" : nav.title}</h1>
        </header>
        {/* keyed by page: each page starts at the top */}
        <div className="sw-scroll" key={q ? "search" : page} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
          <div className="sw-page">
            {errors.map((e) => (
              <div key={e} className="sw-error">
                <Symbol name="exclamationmark.triangle.fill" size={11} />
                {e}
              </div>
            ))}
            {body}
          </div>
        </div>
        {!connected && <div className="sw-offline">Connecting to cmd…</div>}
      </main>
    </div>
  );
}

export function SectionView(p: { title?: string; children: ReactNode }) {
  return (
    <section className="sw-section">
      {p.title && <h2 className="sw-section-title">{p.title}</h2>}
      <div className="sw-list">{p.children}</div>
    </section>
  );
}

/** One row: title and description on the left, the control on the right. */
export function RowShell(p: { title: ReactNode; tip?: string; desc?: ReactNode; note?: ReactNode; noteError?: boolean; children?: ReactNode; className?: string }) {
  return (
    <div className={`sw-row${p.className ? ` ${p.className}` : ""}`}>
      <div className="sw-row-text">
        <div className="sw-row-title" data-tip={p.tip}>
          {p.title}
        </div>
        {p.desc && <div className="sw-row-desc">{p.desc}</div>}
        {p.note && <div className={`sw-row-note${p.noteError ? " error" : ""}`}>{p.note}</div>}
      </div>
      {p.children && <div className="sw-row-control">{p.children}</div>}
    </div>
  );
}

function ItemRow({ k, ctx }: { k: ItemKey; ctx: RowContext }) {
  if (isSecretKey(k)) {
    const def: SecretDef = SECRETS[k];
    const status = ctx.secrets?.[k];
    return (
      <RowShell title={def.title} tip={k} desc={`${def.description} Kept outside settings.json, readable only by you.`}>
        <SecretField set={!!status?.set} hint={status?.hint} placeholder={def.placeholder} onSave={(v) => ctx.saveSecret(k, v)} />
      </RowShell>
    );
  }
  return <SettingRow k={k} ctx={ctx} />;
}

/** The left side of a setting's row: title (key as tooltip, reset when changed) and description. */
function settingText(k: SettingKey, ctx: RowContext) {
  const def: SettingDef = SETTINGS_SCHEMA[k];
  return {
    tip: k,
    title: (
      <>
        <span className="sw-row-name">{settingTitle(k)}</span>
        {ctx.snap.overrides.includes(k) && (
          <button type="button" className="sw-reset" onClick={() => ctx.reset(k)} data-tip="Restore Default">
            <Symbol name="arrow.uturn.backward" size={9} weight="semibold" />
          </button>
        )}
      </>
    ),
    desc: (
      <>
        {prose(def.description)}
        {def.applies && <span className="sw-applies"> {APPLIES_NOTE[def.applies]}</span>}
      </>
    ),
  };
}

function SettingRow({ k, ctx }: { k: SettingKey; ctx: RowContext }) {
  const def: SettingDef = SETTINGS_SCHEMA[k];
  const value = ctx.snap.settings[k];
  const onChange = (v: unknown) => ctx.save(k, v);
  if (def.type === "string" && def.control === "model" && def.provider)
    return <ModelRow k={k} provider={def.provider} value={value as string} ctx={ctx} />;

  let control: ReactNode;
  if (def.type === "boolean") control = <Switch value={value as boolean} onChange={onChange} label={settingTitle(k)} />;
  else if (def.type === "enum")
    control = segmented(def) ? (
      <Segmented value={value as string} options={def.options} labels={def.labels} onChange={onChange} />
    ) : (
      <Popup value={value as string} options={def.options} labels={def.labels} onChange={onChange} />
    );
  else if (def.type === "number") control = <NumberField value={value as number} min={def.min} max={def.max} step={def.step} unit={def.unit} onChange={onChange} />;
  else if (def.control === "theme") control = <ThemePopup value={value as string} appearance={def.appearance} onChange={onChange} />;
  else
    control = (
      <TextField
        value={value as string}
        placeholder={def.placeholder ?? (def.default || undefined)}
        font={def.control === "font" ? (value as string) || undefined : undefined}
        code={def.code}
        onChange={onChange}
      />
    );
  return <RowShell {...settingText(k, ctx)}>{control}</RowShell>;
}

/**
 * A model popup: the models the provider offers to the user's key
 * (magic.models), newest first, listed again when the key changes. A value the
 * list doesn't have stays selectable, marked, so a stale choice is visible
 * rather than silently replaced. What it's waiting for goes under the description.
 */
function ModelRow(p: { k: SettingKey; provider: MagicProvider; value: string; ctx: RowContext }) {
  const key = p.ctx.secrets?.[MAGIC_PROVIDERS[p.provider].keySecret];
  const s = useModels(p.provider, key?.set, key?.hint);
  const list = s.models ?? [];
  const options = list.map((m) => m.id);
  const labels: Record<string, string> = Object.fromEntries(list.map((m) => [m.id, m.name]));
  if (!options.includes(p.value)) {
    options.unshift(p.value);
    labels[p.value] = s.models ? `${p.value} (not available to this key)` : p.value;
  }
  const note = !key?.set ? "Add the API key above to choose a model." : s.loading && !s.models ? "Loading models…" : s.error;
  return (
    <RowShell {...settingText(p.k, p.ctx)} note={note && <span className="sw-model-note">{note}</span>} noteError={!!s.error}>
      <span className="sw-model">
        <span data-tip={p.value}>
          <Popup value={p.value} options={options} labels={labels} disabled={!s.models} onChange={(v) => p.ctx.save(p.k, v)} />
        </span>
        {key?.set && (
          <button type="button" className="sw-button icon" data-tip="List the Models Again" disabled={s.loading} onClick={() => s.load(true)}>
            <Symbol name="arrow.clockwise" size={10} weight="semibold" />
          </button>
        )}
      </span>
    </RowShell>
  );
}

function useModels(provider: MagicProvider, keySet: boolean | undefined, keyHint: string | undefined) {
  const [models, setModels] = useState<MagicModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = (refresh = false) => {
    const n = ++seq.current;
    setError(null);
    if (!keySet) return (setModels(null), setLoading(false));
    setLoading(true);
    cmd.call("magic.models", { provider, refresh }).then(
      (list) => n === seq.current && (setModels(list), setLoading(false)),
      (e: Error) => n === seq.current && (setModels(null), setError(e.message), setLoading(false)),
    );
  };
  useEffect(() => load(), [provider, keySet, keyHint]); // eslint-disable-line react-hooks/exhaustive-deps
  return { models, error, loading, load };
}

/** An error from main without Electron's "Error invoking remote method …" prefix. */
const ipcMessage = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** Settings → Keyboard Shortcuts, or (with `q`) the commands a search finds, as search results. */
function Shortcuts({ q }: { q?: string }) {
  const keys = useKeybindings();
  // The shortcut being recorded: a command and the slot it fills (past the end: a new one).
  const [rec, setRec] = useState<{ id: string; slot: number } | null>(null);
  const [note, setNote] = useState<{ id: string; text: string; error?: boolean } | null>(null);
  const groups = new Map<string, (typeof COMMANDS)[number][]>();
  for (const c of COMMANDS) {
    if (q && !shortcutMatches(c, q)) continue;
    const g = c.id.split(".")[0]!;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  const save = (id: string, list: string[] | null, text?: string) => {
    setNote(text ? { id, text } : null);
    cmd.setKeybinding(id, list).catch((e: Error) => setNote({ id, text: ipcMessage(e), error: true }));
  };

  // Recording: the menu's shortcuts are off, so every key lands here.
  useEffect(() => {
    if (!rec) return;
    cmd.recordShortcut(true);
    const stop = () => setRec(null);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const acc = acceleratorOf(e);
      if (!acc) return;
      if (acc === "Escape") return stop();
      const bound = keys.bindings[rec.id] ?? [];
      if ((acc === "Backspace" || acc === "Delete") && rec.slot < bound.length) return (stop(), save(rec.id, bound.filter((_, i) => i !== rec.slot)));
      if (!usableShortcut(acc)) return setNote({ id: rec.id, text: `${prettyAccelerator(acc)} alone would be typed; add ⌘, ⌃ or ⌥.`, error: true });
      const owner = Object.entries(keys.bindings).find(([o, ks]) => o !== rec.id && ks.some((k) => norm(k) === norm(acc)))?.[0];
      const list = [...bound];
      list.splice(rec.slot, 1, acc);
      stop();
      save(
        rec.id,
        list.filter((k, i) => list.findIndex((x) => norm(x) === norm(k)) === i),
        owner && `${prettyAccelerator(acc)} was ${COMMAND_BY_ID.get(owner)?.label.replace(/…$/, "") ?? owner}’s; it no longer has it.`,
      );
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      cmd.recordShortcut(false);
    };
  }, [rec, keys]); // eslint-disable-line react-hooks/exhaustive-deps

  const changed = (c: CommandSpec) => JSON.stringify(keys.bindings[c.id] ?? []) !== JSON.stringify(DEFAULT_KEYBINDINGS[c.id] ?? []);
  const anyChanged = (COMMANDS as readonly CommandSpec[]).some(changed);
  return (
    <>
      {!q && [...keys.errors, ...(note?.id === "" ? [note.text] : [])].map((e) => (
        <div key={e} className="sw-error">
          <Symbol name="exclamationmark.triangle.fill" size={11} />
          {e}
        </div>
      ))}
      {[...groups].map(([g, cmds]) => (
        <SectionView key={g} title={q ? `Keyboard Shortcuts › ${COMMAND_GROUPS[g] ?? g}` : (COMMAND_GROUPS[g] ?? g)}>
          {cmds.map((c) => {
            const bound = keys.bindings[c.id] ?? [];
            const slot = rec?.id === c.id ? rec.slot : -1;
            const recording = <kbd className="recording">Type a shortcut…</kbd>;
            return (
              <RowShell
                key={c.id}
                className="shortcut"
                tip={c.id}
                note={note?.id === c.id && note.text}
                noteError={note?.error}
                title={
                  <>
                    <span className="sw-row-name">{c.label.replace(/…$/, "")}</span>
                    {changed(c) && (
                      <button type="button" className="sw-reset" onClick={() => (setRec(null), save(c.id, null))} data-tip="Restore Default">
                        <Symbol name="arrow.uturn.backward" size={9} weight="semibold" />
                      </button>
                    )}
                  </>
                }
              >
                <span className="sw-keys">
                  {bound.map((k, i) =>
                    i === slot ? (
                      <span key={k}>{recording}</span>
                    ) : (
                      <span key={k} className="sw-key">
                        <kbd data-tip="Click to change" onClick={() => (setNote(null), setRec({ id: c.id, slot: i }))}>
                          {prettyAccelerator(k)}
                        </kbd>
                        <button type="button" className="sw-key-remove" data-tip="Remove" onClick={() => save(c.id, bound.filter((_, j) => j !== i))}>
                          <Symbol name="xmark" size={7} weight="bold" />
                        </button>
                      </span>
                    ),
                  )}
                  {slot === bound.length ? (
                    recording
                  ) : (
                    <button
                      type="button"
                      className="sw-key-add"
                      data-tip={bound.length ? "Add Another Shortcut" : "Add a Shortcut"}
                      onClick={() => (setNote(null), setRec({ id: c.id, slot: bound.length }))}
                    >
                      <Symbol name="plus" size={9} weight="semibold" />
                    </button>
                  )}
                </span>
              </RowShell>
            );
          })}
        </SectionView>
      ))}
      {!q && (
        <div className="sw-page-foot">
          <span className="sw-hint">Click a shortcut to change it, then press the new keys. Esc cancels, ⌫ removes.</span>
          <button className="sw-button" onClick={() => cmd.openKeybindingsFile()}>
            Edit keybindings.json…
          </button>
          <button
            className="sw-button"
            disabled={!anyChanged}
            onClick={() => (setRec(null), cmd.resetKeybindings().then(() => setNote(null), (e: Error) => setNote({ id: "", text: ipcMessage(e), error: true })))}
          >
            Restore Defaults
          </button>
        </div>
      )}
    </>
  );
}

/** Under "Index transcripts": how much is indexed, progress while indexing, and Rebuild Index. */
function IndexStatusRow(p: { status: SearchStatus | null; enabled: boolean }) {
  const s = p.status;
  const busy = !!s?.indexing;
  const text = !p.enabled
    ? "Indexing is off."
    : busy && s.total
      ? `Indexing ${s.done.toLocaleString()} of ${s.total.toLocaleString()}…`
      : busy
        ? "Indexing…"
        : s
          ? `${s.sessions.toLocaleString()} session${s.sessions === 1 ? "" : "s"} indexed.`
          : "";
  return (
    <RowShell
      title="Index"
      desc={
        <span className="sw-index-status">
          <IndexRing status={s} />
          {text}
        </span>
      }
    >
      <button
        className="sw-button"
        disabled={!p.enabled || busy}
        title="Read every transcript again, e.g. after moving folders or an update"
        onClick={() => void cmd.call("search.reindex", {})}
      >
        Rebuild Index
      </button>
    </RowShell>
  );
}

/** The registered themes of one appearance; a value naming no theme (removed) stays listed so it shows. */
function ThemePopup(p: { value: string; appearance?: "dark" | "light"; onChange: (v: string) => void }) {
  const themes = allThemes().filter((t) => !p.appearance || t.appearance === p.appearance);
  const labels: Record<string, string> = Object.fromEntries(themes.map((t) => [t.id, t.title]));
  const options = themes.map((t) => t.id);
  if (!labels[p.value]) (options.push(p.value), (labels[p.value] = `${p.value} (not found)`));
  return <Popup value={p.value} options={options} labels={labels} onChange={p.onChange} />;
}

