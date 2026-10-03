// The Settings window, generated from SETTINGS_SCHEMA: a sidebar page per group
// (SETTINGS_GROUPS) plus Keyboard Shortcuts, each page one dense list of rows
// that shows the key beside the title (what you'd type in `cmd settings set`).
// The control comes from the key's type and display hints; nothing is hand-wired.
// Secrets (API keys, SECRETS) appear as rows too, next to the settings that
// share their prefix, but are stored by the core outside settings.json.

import { useEffect, useMemo, useRef, useState } from "react";
import {
  APPLIES_LABEL,
  MAGIC_PROVIDERS,
  SECRETS,
  SETTINGS_GROUPS,
  SETTINGS_SCHEMA,
  settingTitle,
  type MagicModel,
  type MagicProvider,
  type SecretDef,
  type SecretKey,
  type SecretsStatus,
  type SettingDef,
  type SettingKey,
  type SearchStatus,
  type Settings,
} from "@cmd/protocol";
import { COMMANDS, DEFAULT_KEYBINDINGS, prettyAccelerator } from "../../../shared/commands.ts";
import { Symbol } from "../components/Symbol.tsx";
import { IndexRing } from "../components/IndexRing.tsx";
import { useKeybindings } from "../keybindings.ts";
import { cmd } from "../bridge.ts";
import { NumberField, Popup, SecretField, Segmented, Switch, TextField } from "./controls.tsx";
import { useSettings } from "./useSettings.ts";
import { About } from "./About.tsx";
import { allThemes } from "../themes/registry.ts";

type Group = keyof typeof SETTINGS_GROUPS;
type Page = Group | "keyboard" | "about";

/** Sidebar icons (SF Symbols, monochrome). */
const ICONS: Record<Page, string> = {
  theme: "paintpalette",
  font: "textformat",
  terminal: "terminal",
  shell: "chevron.left.forwardslash.chevron.right",
  open: "arrow.up.forward.app",
  ui: "macwindow",
  canvas: "square.grid.3x3",
  notifications: "bell",
  search: "magnifyingglass",
  agents: "sparkles",
  magic: "wand.and.stars",
  updates: "arrow.down.circle",
  keyboard: "keyboard",
  about: "info.circle",
};

const PAGES: Page[] = [...(Object.keys(SETTINGS_GROUPS) as Group[]), "keyboard", "about"];
const pageTitle = (p: Page) => (p === "keyboard" ? "Keyboard Shortcuts" : p === "about" ? "About" : SETTINGS_GROUPS[p]);
const groupOf = (k: SettingKey | SecretKey) => k.split(".")[0] as Group;
const KEYS = Object.keys(SETTINGS_SCHEMA) as SettingKey[];
const SECRET_KEYS = Object.keys(SECRETS) as SecretKey[];

type Item = { kind: "setting"; k: SettingKey } | { kind: "secret"; k: SecretKey };
const prefixOf = (k: string) => k.split(".").slice(0, -1).join(".") + ".";
/** Rows in schema order, each secret just before the first setting with its prefix (the key above "magic.anthropic.model"). */
function itemsOf(keys: SettingKey[], secrets: SecretKey[]): Item[] {
  const out: Item[] = [];
  const placed = new Set<SecretKey>();
  for (const k of keys) {
    for (const sk of secrets) if (!placed.has(sk) && prefixOf(sk) === prefixOf(k)) (out.push({ kind: "secret", k: sk }), placed.add(sk));
    out.push({ kind: "setting", k });
  }
  for (const sk of secrets) if (!placed.has(sk)) out.push({ kind: "secret", k: sk });
  return out;
}

const COMMAND_GROUPS: Record<string, string> = { app: "App", file: "File", edit: "Edit", view: "View", session: "Sessions", help: "Help" };

const PAGE_KEY = "settings.page";
function initialPage(): Page {
  try {
    const p = localStorage.getItem(PAGE_KEY) as Page | null;
    if (p && PAGES.includes(p)) return p;
  } catch {}
  return "font";
}

const matches = (k: SettingKey, q: string) => {
  const d: SettingDef = SETTINGS_SCHEMA[k];
  return [settingTitle(k), d.description, k].some((t) => t.toLowerCase().includes(q));
};
const secretMatches = (k: SecretKey, q: string) => {
  const d: SecretDef = SECRETS[k];
  return [d.title, d.description, k].some((t) => t.toLowerCase().includes(q));
};

export function SettingsWindow() {
  const { snapshot: snap, connected, search, secrets } = useSettings();
  const [page, setPage] = useState<Page>(initialPage);
  const [query, setQuery] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [scrolled, setScrolled] = useState(false);
  const q = query.trim().toLowerCase();

  useEffect(() => {
    try {
      localStorage.setItem(PAGE_KEY, page);
    } catch {}
    document.title = pageTitle(page);
  }, [page]);

  const save = async (key: SettingKey, value: unknown) => {
    try {
      setError(null);
      await cmd.call("settings.set", { key, value });
    } catch (err) {
      setError((err as Error).message);
    }
  };
  const reset = (key: SettingKey) => void cmd.call("settings.reset", { key }).catch((err: Error) => setError(err.message));

  const saveSecret = (key: SecretKey, value: string | null) =>
    void cmd.call("secrets.set", { key, value }).then(() => setError(null), (err: Error) => setError(err.message));

  const hits = useMemo(() => (q ? KEYS.filter((k) => matches(k, q)) : []), [q]);
  const secretHits = useMemo(() => (q ? SECRET_KEYS.filter((k) => secretMatches(k, q)) : []), [q]);
  const hitGroups = new Set([...hits, ...secretHits].map(groupOf));
  const errors = [...snap.errors, ...(error ? [error] : [])];

  const rows = (items: Item[]) =>
    items.map((it) =>
      it.kind === "secret" ? (
        <SecretRow key={it.k} k={it.k} status={secrets?.[it.k]} onSave={(v) => saveSecret(it.k, v)} />
      ) : (
        <Row
          key={it.k}
          k={it.k}
          settings={snap.settings}
          secrets={secrets}
          overridden={snap.overrides.includes(it.k)}
          onSave={(v) => void save(it.k, v)}
          onReset={() => reset(it.k)}
        />
      ),
    );

  let body;
  if (q) {
    body = hits.length || secretHits.length ? (
      (Object.keys(SETTINGS_GROUPS) as Group[])
        .filter((g) => hitGroups.has(g))
        .map((g) => (
          <section key={g}>
            <h2 className="sw-section-title">{SETTINGS_GROUPS[g]}</h2>
            <div className="sw-list">{rows(itemsOf(hits.filter((k) => groupOf(k) === g), secretHits.filter((k) => groupOf(k) === g)))}</div>
          </section>
        ))
    ) : (
      <div className="sw-empty">No settings match “{query.trim()}”</div>
    );
  } else if (page === "keyboard") {
    body = <Shortcuts />;
  } else if (page === "about") {
    body = <About />;
  } else {
    const keys = KEYS.filter((k) => groupOf(k) === page);
    const changed = keys.filter((k) => snap.overrides.includes(k));
    body = (
      <>
        <div className="sw-list">{rows(itemsOf(keys, SECRET_KEYS.filter((k) => groupOf(k) === page)))}</div>
        <div className="sw-page-foot">
          {page === "search" && <IndexStatusFoot status={search} enabled={snap.settings["search.enabled"]} />}
          <button className="sw-button" disabled={!changed.length} onClick={() => changed.forEach(reset)}>
            Restore Defaults
          </button>
        </div>
      </>
    );
  }

  return (
    <div className="sw">
      <aside className="sw-side">
        <div className="sw-drag" />
        <label className="sw-search">
          <Symbol name="magnifyingglass" size={11} weight="semibold" />
          <input
            type="search"
            placeholder="Filter settings"
            value={query}
            spellCheck={false}
            onChange={(e) => (setQuery(e.target.value), setScrolled(false))}
            onKeyDown={(e) => e.key === "Escape" && setQuery("")}
          />
        </label>
        <nav className="sw-nav">
          {PAGES.map((p) => (
            <button
              key={p}
              type="button"
              className={`sw-nav-item${!q && p === page ? " sel" : ""}${q && !hitGroups.has(p as Group) ? " dim" : ""}`}
              onClick={() => (setQuery(""), setPage(p), setScrolled(false))}
            >
              {/* fixed-width box: symbols differ in width, the labels should line up */}
              <span className="sw-nav-icon">
                <Symbol name={ICONS[p]} size={12} />
              </span>
              <span className="sw-nav-label">{pageTitle(p)}</span>
            </button>
          ))}
        </nav>
        <button className="sw-side-foot" onClick={() => cmd.openSettingsFile(snap.path)} disabled={!snap.path} title={snap.path}>
          <Symbol name="curlybraces" size={11} weight="semibold" />
          Open settings.json
        </button>
      </aside>
      <main className="sw-main">
        <header className={`sw-bar${scrolled ? " scrolled" : ""}`}>
          <h1>{q ? "Results" : pageTitle(page)}</h1>
        </header>
        {/* keyed by page: each page starts at the top */}
        <div className="sw-scroll" key={q ? "search" : page} onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}>
          {errors.map((e) => (
            <div key={e} className="sw-error">
              <Symbol name="exclamationmark.triangle.fill" size={11} />
              {e}
            </div>
          ))}
          {body}
        </div>
        {!connected && <div className="sw-offline">Connecting to cmd…</div>}
      </main>
    </div>
  );
}

function Row(p: { k: SettingKey; settings: Settings; secrets: SecretsStatus | null; overridden: boolean; onSave: (v: unknown) => void; onReset: () => void }) {
  const def: SettingDef = SETTINGS_SCHEMA[p.k];
  const value = p.settings[p.k];
  const title = settingTitle(p.k);
  // Text values can be long (font lists, commands): the field goes under the label.
  const stacked = def.type === "string" && def.control !== "theme" && def.control !== "model";

  let control;
  if (def.type === "boolean") control = <Switch value={value as boolean} onChange={p.onSave} label={title} />;
  else if (def.type === "enum")
    control =
      def.options.length <= 4 ? (
        <Segmented value={value as string} options={def.options} labels={def.labels} onChange={p.onSave} />
      ) : (
        <Popup value={value as string} options={def.options} labels={def.labels} onChange={p.onSave} />
      );
  else if (def.type === "string" && def.control === "theme") control = <ThemePopup value={value as string} appearance={def.appearance} onChange={p.onSave} />;
  else if (def.type === "string" && def.control === "model" && def.provider) {
    const key = p.secrets?.[MAGIC_PROVIDERS[def.provider].keySecret];
    control = <ModelPopup provider={def.provider} value={value as string} keySet={key?.set} keyHint={key?.hint} onChange={p.onSave} />;
  }
  else if (def.type === "number")
    control = <NumberField value={value as number} min={def.min} max={def.max} step={def.step} unit={def.unit} onChange={p.onSave} />;
  else
    control = (
      <TextField
        value={value as string}
        placeholder={def.placeholder ?? (def.default || undefined)}
        font={def.control === "font" ? (value as string) : undefined}
        onChange={p.onSave}
      />
    );

  return (
    <div className={`sw-row${stacked ? " stacked" : ""}`}>
      <div className="sw-row-text">
        <div className="sw-row-title">
          {title}
          <span className="sw-row-key">{p.k}</span>
          {def.applies && <span className="sw-tag">{APPLIES_LABEL[def.applies]}</span>}
          {p.overridden && (
            <button type="button" className="sw-reset" onClick={p.onReset} title="Restore default">
              <Symbol name="arrow.uturn.backward" size={9} weight="semibold" />
            </button>
          )}
        </div>
        <div className="sw-row-desc">{def.description}</div>
      </div>
      <div className="sw-row-control">
        {control}
      </div>
    </div>
  );
}

/** An API key (SECRETS): set or not, never shown; stored by the core outside settings.json. */
function SecretRow(p: { k: SecretKey; status: { set: boolean; hint?: string } | undefined; onSave: (v: string | null) => void }) {
  const def: SecretDef = SECRETS[p.k];
  return (
    <div className="sw-row">
      <div className="sw-row-text">
        <div className="sw-row-title">
          {def.title}
          <span className="sw-row-key">{p.k}</span>
        </div>
        <div className="sw-row-desc">{def.description} Stored by cmd outside settings.json, readable only by you.</div>
      </div>
      <div className="sw-row-control">
        <SecretField set={!!p.status?.set} hint={p.status?.hint} placeholder={def.placeholder} onSave={p.onSave} />
      </div>
    </div>
  );
}

/**
 * The models the provider offers to the user's key (magic.models), newest
 * first, listed again when the key changes. A value the list doesn't have stays
 * selectable, marked, so a stale choice is visible rather than silently replaced.
 */
function ModelPopup(p: { provider: MagicProvider; value: string; keySet: boolean | undefined; keyHint?: string; onChange: (v: string) => void }) {
  const [models, setModels] = useState<MagicModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = (refresh = false) => {
    const n = ++seq.current;
    setError(null);
    if (!p.keySet) return (setModels(null), setLoading(false));
    setLoading(true);
    cmd.call("magic.models", { provider: p.provider, refresh }).then(
      (list) => n === seq.current && (setModels(list), setLoading(false)),
      (e: Error) => n === seq.current && (setModels(null), setError(e.message), setLoading(false)),
    );
  };
  useEffect(() => load(), [p.provider, p.keySet, p.keyHint]); // eslint-disable-line react-hooks/exhaustive-deps

  const list = models ?? [];
  const options = list.map((m) => m.id);
  const labels: Record<string, string> = Object.fromEntries(list.map((m) => [m.id, m.name]));
  if (!options.includes(p.value)) {
    options.unshift(p.value);
    labels[p.value] = models ? `${p.value} (not available to this key)` : p.value;
  }
  const note = !p.keySet ? "Add the API key above to choose" : loading && !models ? "Loading models…" : error;
  return (
    <span className="sw-model">
      {note && <span className={`sw-model-note${error ? " error" : ""}`}>{note}</span>}
      <span title={p.value}>
        <Popup value={p.value} options={options} labels={labels} disabled={!models} onChange={p.onChange} />
      </span>
      {p.keySet && (
        <button type="button" className="sw-button" title="List the models again" disabled={loading} onClick={() => load(true)}>
          <Symbol name="arrow.clockwise" size={10} weight="semibold" />
        </button>
      )}
    </span>
  );
}

function Shortcuts() {
  const keys = useKeybindings();
  const groups = new Map<string, (typeof COMMANDS)[number][]>();
  for (const c of COMMANDS) {
    const g = c.id.split(".")[0]!;
    groups.set(g, [...(groups.get(g) ?? []), c]);
  }
  return (
    <>
      {keys.errors.map((e) => (
        <div key={e} className="sw-error">
          <Symbol name="exclamationmark.triangle.fill" size={11} />
          {e}
        </div>
      ))}
      {[...groups].map(([g, cmds]) => (
        <section key={g}>
          <h2 className="sw-section-title">{COMMAND_GROUPS[g] ?? g}</h2>
          <div className="sw-list">
            {cmds.map((c) => {
              const bound = keys.bindings[c.id] ?? [];
              const changed = JSON.stringify(bound) !== JSON.stringify(DEFAULT_KEYBINDINGS[c.id] ?? []);
              return (
                <div className="sw-row shortcut" key={c.id}>
                  <div className="sw-row-text">
                    <div className="sw-row-title">
                      {c.label.replace(/…$/, "")}
                      <span className="sw-row-key">{c.id}</span>
                      {changed && <span className="sw-tag accent">customized</span>}
                    </div>
                  </div>
                  <div className="sw-row-control keys">
                    {bound.length ? bound.map((k) => <kbd key={k}>{prettyAccelerator(k)}</kbd>) : <span className="sw-none">None</span>}
                  </div>
                </div>
              );
            })}
          </div>
        </section>
      ))}
      <div className="sw-page-foot">
        <button className="sw-button" onClick={() => cmd.openKeybindingsFile()}>
          Edit keybindings.json…
        </button>
      </div>
    </>
  );
}

/** Search page: how much is indexed, progress while indexing, and Rebuild Index. */
function IndexStatusFoot(p: { status: SearchStatus | null; enabled: boolean }) {
  const s = p.status;
  const busy = !!s?.indexing;
  const text = !p.enabled
    ? "Indexing is off"
    : busy && s.total
      ? `Indexing ${s.done.toLocaleString()} / ${s.total.toLocaleString()}…`
      : busy
        ? "Indexing…"
        : s
          ? `${s.sessions.toLocaleString()} session${s.sessions === 1 ? "" : "s"} indexed`
          : "";
  return (
    <>
      <span className="sw-index-status">
        <IndexRing status={s} />
        {text}
      </span>
      <button
        className="sw-button"
        disabled={!p.enabled || busy}
        title="Read every transcript again, e.g. after moving folders or an update"
        onClick={() => void cmd.call("search.reindex", {})}
      >
        Rebuild Index
      </button>
    </>
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
