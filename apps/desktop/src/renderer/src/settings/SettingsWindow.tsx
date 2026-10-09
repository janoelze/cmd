// The Settings window: the pages and sections of layout.ts in a sidebar (Split),
// each section one list of rows generated from SETTINGS_SCHEMA:
// the title, a one-line description and an info button for the details on the
// left, a control chosen from the key's type and display hints on the right.
// The key itself (what `cmd settings set` takes) is the title's tooltip. Secrets (API keys, SECRETS) are rows too but
// are stored by the core outside settings.json. Pages that aren't settings
// (Browser's site permissions, Keyboard Shortcuts, Updates & About) are added to
// the sidebar here and draw themselves.

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  AUTO_MODEL,
  SECRETS,
  SETTINGS_SCHEMA,
  isSecretKey,
  settingTitle,
  type AiModel,
  type AiProvider,
  type AiTier,
  type SecretDef,
  type SecretKey,
  type SecretsStatus,
  type SettingDef,
  type SettingKey,
  type SearchStatus,
  type Settings,
  type SettingsSnapshot,
} from "@cmd/protocol";
import { COMMANDS, COMMAND_BY_ID, DEFAULT_KEYBINDINGS, norm, prettyAccelerator, type CommandSpec } from "../../../shared/commands.ts";
import { IndexRing } from "../components/IndexRing.tsx";
import { acceleratorOf, usableShortcut, useKeybindings } from "../keybindings.ts";
import { cmd } from "../bridge.ts";
import { Button, Callout, EmptyState, FormActions, FormRow, FormSection, IconButton, Inline, List, ListRow, NumberField, Page, ResetButton, SearchField, SecretField, Segmented, Select, ShortcutField, Spinner, Split, Stack, StatusLine, Switch, TextField, TitleBand, View } from "@cmd/ui";
import { useSettings } from "./useSettings.ts";
import { AiKeyRow, AiProviderChoice } from "../ai/Providers.tsx";
import { useAiStatus } from "../ai/status.ts";
import { About } from "./About.tsx";
import { Remote, useAccessModes } from "./Remote.tsx";
import { AgentHooks } from "./AgentHooks.tsx";
import { NotifyPermission } from "./NotifyPermission.tsx";
import { SITE_PERMISSION_WORDS, SitePermissions } from "./SitePermissions.tsx";
import { allThemes } from "@cmd/ui/themes";
import { itemKey, itemShown, settingsPages, type Item, type ItemKey, type Page as SettingsPage } from "./layout.ts";

const PAGES: SettingsPage[] = settingsPages();
type Nav = { id: string; title: string; icon: string };
const NAV: Nav[] = [...PAGES, { id: "browser", title: "Browser", icon: "globe" }, { id: "keyboard", title: "Keyboard Shortcuts", icon: "keyboard" }, { id: "about", title: "Updates & About", icon: "info.circle" }];

const APPLIES_NOTE = { newTerminals: "Applies to new terminals.", firstLaunch: "Applies on first launch." } as const;
const COMMAND_GROUPS: Record<string, string> = { app: "App", file: "File", edit: "Edit", view: "View", session: "Sessions", workspace: "Workspaces", help: "Help" };

const PAGE_KEY = "settings.page";
/** Opened at a page (main's openSettings): "remote", or "remote/pair" to show a pairing code. */
const askedPage = new URLSearchParams(location.search).get("page");
function initialPage(): string {
  const asked = askedPage?.split("/")[0];
  if (asked && NAV.some((n) => n.id === asked)) return asked;
  try {
    // "agents" was its own page before it joined "ai".
    const p = localStorage.getItem(PAGE_KEY)?.replace(/^agents$/, "ai");
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
  return [settingTitle(k), d.description, d.details ?? "", k];
};
const matches = (k: ItemKey, q: string) => textOf(k).some((t) => t.toLowerCase().includes(q));
const shortcutMatches = (c: CommandSpec, q: string) => [c.label, c.id].some((t) => t.toLowerCase().includes(q));
const sitePermissionMatches = (q: string) => SITE_PERMISSION_WORDS.some((w) => w.includes(q) || q.includes(w));

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
  const siteHits = !!q && sitePermissionMatches(q);
  const hitPages = new Set([...hits.map((h) => h.page.id), ...(siteHits ? ["browser"] : []), ...(shortcutHits ? ["keyboard"] : [])]);
  const errors = [...snap.errors, ...(error ? [error] : [])];

  let body: ReactNode;
  if (q) {
    body = hits.length || siteHits || shortcutHits ? (
      <>
        {hits.map((h) => (
          <FormSection key={`${h.page.id}/${h.section.title}`} title={[h.page.title, h.section.title].filter(Boolean).join(" › ")}>
            {h.items.map((k) => (
              <ItemRow key={k} k={k} ctx={ctx} />
            ))}
          </FormSection>
        ))}
        {siteHits && (
          <FormSection title="Browser › Site permissions" plain>
            <SitePermissions />
          </FormSection>
        )}
        {shortcutHits > 0 && <Shortcuts q={q} />}
      </>
    ) : (
      <EmptyState title={`No settings match “${query.trim()}”`} />
    );
  } else if (page === "browser") {
    body = <SitePermissions />;
  } else if (page === "keyboard") {
    body = <Shortcuts />;
  } else if (page === "remote") {
    body = <Remote key={pairAsk} status={remote} settings={snap.settings} pair={pairAsk > 0} row={(k) => <ItemRow k={k} ctx={ctx} />} />;
  } else if (page === "about") {
    body = <About updates={<ItemRow k="updates.mode" ctx={ctx} />} crashReports={<ItemRow k="diagnostics.crashReports" ctx={ctx} />} usageStats={<ItemRow k="diagnostics.usageStats" ctx={ctx} />} />;
  } else {
    const p = PAGES.find((x) => x.id === page)!;
    const keys = p.sections.flatMap((s) => s.items.map(itemKey)).filter((k): k is SettingKey => !isSecretKey(k));
    const changed = keys.filter((k) => snap.overrides.includes(k));
    body = (
      <>
        {p.sections.map((s, i) => {
          const items = s.items.filter((it: Item) => itemShown(it, snap.settings, secrets));
          if (!items.length) return null;
          const section = (
            <FormSection key={s.title ?? i} title={s.title}>
              {items.map((it) => (
                <ItemRow key={itemKey(it)} k={itemKey(it)} ctx={ctx} />
              ))}
              {s.items.some((it) => itemKey(it) === "search.archiveDirs") && <IndexStatusRow status={search} enabled={snap.settings["data.record.transcripts"]} />}
            </FormSection>
          );
          // cmd's hook goes before what needs it (peer briefings).
          if (s.items.some((it) => itemKey(it) === "agents.peers")) return [<AgentHooks key="hooks" />, section];
          // Whether macOS shows them at all, before what to notify about.
          if (s.items.some((it) => itemKey(it) === "notifications.needsInput")) return [<NotifyPermission key="macos" />, section];
          return section;
        })}
        <FormActions>
          <Button disabled={!changed.length} onClick={() => changed.forEach(ctx.reset)}>
            Restore Defaults
          </Button>
        </FormActions>
      </>
    );
  }

  return (
    <View scroll={false}>
      <Split
        width={{ min: 180, ideal: 220, max: 300 }}
        pane={
          <Stack gap="none" grow>
            <TitleBand />
            <Stack pad="lg">
              <SearchField ref={input} size="lg" value={query} placeholder="Search settings" onChange={(v) => (setQuery(v), setScrolled(false))} />
            </Stack>
            <Stack gap="none" grow>
              <List>
                {NAV.map((n) => (
                  <ListRow key={n.id} icon={n.icon} title={n.title} selected={!q && n.id === page} dim={!!q && !hitPages.has(n.id)} onClick={() => (setQuery(""), setPage(n.id), setScrolled(false))} />
                ))}
              </List>
            </Stack>
            <Stack pad="lg" align="start">
              <Button variant="ghost" icon="curlybraces" onClick={() => cmd.openSettingsFile(snap.path)} disabled={!snap.path} data-tip={snap.path}>
                Open settings.json
              </Button>
            </Stack>
          </Stack>
        }
      >
        <View
          // keyed by page: each page starts at the top
          key={q ? "search" : page}
          inset
          toolbar={<TitleBand title={q ? "Search Results" : nav.title} line={scrolled} />}
          onScroll={(e) => setScrolled(e.currentTarget.scrollTop > 0)}
          footer={
            !connected && (
              <StatusLine>
                <Inline gap="sm">
                  <Spinner size={11} />
                  Connecting to cmd…
                </Inline>
              </StatusLine>
            )
          }
        >
          <Page>
            <Stack gap="lg">
              {errors.map((e) => (
                <Callout key={e} tone="danger">
                  {e}
                </Callout>
              ))}
              <div>{body}</div>
            </Stack>
          </Page>
        </View>
      </Split>
    </View>
  );
}

/** A provider's key row (checked with the provider), by its secret. */
const aiKeyOf = (k: ItemKey): AiProvider | undefined => AI_PROVIDER_IDS.find((p) => AI_PROVIDERS[p].keySecret === k);

function ItemRow({ k, ctx }: { k: ItemKey; ctx: RowContext }) {
  const aiKey = aiKeyOf(k);
  if (aiKey) return <AiKeyRow provider={aiKey} />;
  if (k === "ai.provider") return <AiProviderChoice />;
  if (isSecretKey(k)) {
    const def: SecretDef = SECRETS[k];
    const status = ctx.secrets?.[k];
    return (
      <FormRow title={def.title} tip={k} description={def.description}>
        <SecretField set={!!status?.set} hint={status?.hint} placeholder={def.placeholder} onSave={(v) => ctx.saveSecret(k, v)} />
      </FormRow>
    );
  }
  return <SettingRow k={k} ctx={ctx} />;
}

/** The left side of a setting's row: title (key as tooltip, reset when changed), description and details. */
function settingText(k: SettingKey, ctx: RowContext) {
  const def: SettingDef = SETTINGS_SCHEMA[k];
  return {
    tip: k,
    title: settingTitle(k),
    accessory: ctx.snap.overrides.includes(k) && <ResetButton label="Restore Default" onClick={() => ctx.reset(k)} />,
    description: (
      <>
        {prose(def.description)}
        {def.applies && <i> {APPLIES_NOTE[def.applies]}</i>}
      </>
    ),
    info: def.details && prose(def.details),
  };
}

function SettingRow({ k, ctx }: { k: SettingKey; ctx: RowContext }) {
  const def: SettingDef = SETTINGS_SCHEMA[k];
  const value = ctx.snap.settings[k];
  const onChange = (v: unknown) => ctx.save(k, v);
  if (def.type === "string" && def.control === "model" && def.provider && def.tier)
    return <ModelRow k={k} provider={def.provider} tier={def.tier} value={value as string} ctx={ctx} />;
  if (def.type === "string" && def.control === "access") return <AccessRow k={k} value={value as string} ctx={ctx} />;

  let control: ReactNode;
  if (def.type === "boolean") control = <Switch checked={value as boolean} onChange={onChange} label={settingTitle(k)} />;
  else if (def.type === "enum")
    control = segmented(def) ? (
      <Segmented value={value as string} options={def.options} labels={def.labels} onChange={onChange} />
    ) : (
      <Select value={value as string} options={def.options} labels={def.labels} onChange={onChange} />
    );
  else if (def.type === "number") control = <NumberField value={value as number} min={def.min} max={def.max} step={def.step} unit={def.unit} onChange={onChange} />;
  else if (def.control === "theme") control = <ThemePopup value={value as string} appearance={def.appearance} onChange={onChange} />;
  else
    control = (
      <TextField
        value={value as string}
        placeholder={def.placeholder ?? (def.default || undefined)}
        // The font setting shows itself in its font.
        style={def.control === "font" && value ? { fontFamily: `${value as string}, var(--font-mono)` } : undefined}
        code={def.code}
        onCommit={onChange}
      />
    );
  return <FormRow {...settingText(k, ctx)}>{control}</FormRow>;
}

/**
 * A model popup: Auto first (naming what it picks now), then the models the
 * provider offers to the user's key (ai.models), newest first, listed again
 * when the key changes. A value the list doesn't have stays selectable,
 * marked, so a stale choice is visible rather than silently replaced.
 */
function ModelRow(p: { k: SettingKey; provider: AiProvider; tier: AiTier; value: string; ctx: RowContext }) {
  const ai = useAiStatus();
  const st = ai?.providers[p.provider];
  const s = useModels(p.provider, st?.key.set, st?.key.hint);
  const list = s.models ?? [];
  const value = p.value.trim() || AUTO_MODEL;
  const current = st?.models?.[p.tier];
  const options = [AUTO_MODEL, ...list.map((m) => m.id)];
  const labels: Record<string, string> = {
    [AUTO_MODEL]: current?.auto ? `Auto (${current.name})` : "Auto (newest)",
    ...Object.fromEntries(list.map((m) => [m.id, m.name])),
  };
  if (!options.includes(value)) {
    options.splice(1, 0, value);
    labels[value] = s.models ? `${value} (not available to this key)` : (current?.name ?? value);
  }
  // A refused key says so on its own row.
  const note = st?.state === "rejected" ? null : s.loading && !s.models ? "Loading models…" : s.error;
  return (
    <FormRow {...settingText(p.k, p.ctx)} note={note} noteTone={!!s.error ? "danger" : "accent"}>
      <Inline gap="sm">
        <span data-tip={current?.id}>
          <Select value={value} options={options} labels={labels} onChange={(v) => p.ctx.save(p.k, v)} />
        </span>
        <IconButton variant="default" icon="arrow.clockwise" iconSize={10} label="List the Models Again" disabled={s.loading} onClick={() => s.load(true)} />
      </Inline>
    </FormRow>
  );
}

/**
 * How phones reach this Mac: a popup of the core's access modes (remote.modes).
 * A value the core doesn't have stays selectable, marked, as in ModelRow.
 */
function AccessRow(p: { k: SettingKey; value: string; ctx: RowContext }) {
  const modes = useAccessModes();
  const options = (modes ?? []).map((m) => m.id);
  const labels: Record<string, string> = Object.fromEntries((modes ?? []).map((m) => [m.id, m.title]));
  if (!options.includes(p.value)) {
    options.push(p.value);
    labels[p.value] = modes ? `${p.value} (not in this version)` : p.value;
  }
  return (
    <FormRow {...settingText(p.k, p.ctx)}>
      <span data-tip={modes?.find((m) => m.id === p.value)?.description}>
        <Select value={p.value} options={options} labels={labels} onChange={(v) => p.ctx.save(p.k, v)} />
      </span>
    </FormRow>
  );
}

function useModels(provider: AiProvider, keySet: boolean | undefined, keyHint: string | undefined) {
  const [models, setModels] = useState<AiModel[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const seq = useRef(0);
  const load = (refresh = false) => {
    const n = ++seq.current;
    setError(null);
    if (!keySet) return (setModels(null), setLoading(false));
    setLoading(true);
    cmd.call("ai.models", { provider, refresh }).then(
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
        <Callout key={e} tone="danger">
          {e}
        </Callout>
      ))}
      {[...groups].map(([g, cmds]) => (
        <FormSection key={g} title={q ? `Keyboard Shortcuts › ${COMMAND_GROUPS[g] ?? g}` : (COMMAND_GROUPS[g] ?? g)}>
          {cmds.map((c) => {
            const bound = keys.bindings[c.id] ?? [];
            const slot = rec?.id === c.id ? rec.slot : undefined;
            return (
              <FormRow
                key={c.id}
                compact
                tip={c.id}
                note={note?.id === c.id && note.text}
                noteTone={note?.error ? "danger" : "accent"}
                title={c.label.replace(/…$/, "")}
                accessory={changed(c) && <ResetButton label="Restore Default" onClick={() => (setRec(null), save(c.id, null))} />}
              >
                <ShortcutField
                  keys={bound.map((k) => prettyAccelerator(k) ?? k)}
                  recording={slot}
                  onRecord={(i) => (setNote(null), setRec({ id: c.id, slot: i }))}
                  onRemove={(i) => save(c.id, bound.filter((_, j) => j !== i))}
                />
              </FormRow>
            );
          })}
        </FormSection>
      ))}
      {!q && (
        <FormActions hint="Click a shortcut to change it, then press the new keys. Esc cancels, ⌫ removes.">
          <Button onClick={() => cmd.openKeybindingsFile()}>
            Edit keybindings.json…
          </Button>
          <Button
            disabled={!anyChanged}
            onClick={() => (setRec(null), cmd.resetKeybindings().then(() => setNote(null), (e: Error) => setNote({ id: "", text: ipcMessage(e), error: true })))}
          >
            Restore Defaults
          </Button>
        </FormActions>
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
    <FormRow
      title="Index"
      description={
        <Inline gap="sm">
          <IndexRing status={s} />
          {text}
        </Inline>
      }
    >
      <Button
        disabled={!p.enabled || busy}
        title="Read every transcript again, e.g. after moving folders or an update"
        onClick={() => void cmd.call("search.reindex", {})}
      >
        Rebuild Index
      </Button>
    </FormRow>
  );
}

/** The registered themes of one appearance; a value naming no theme (removed) stays listed so it shows. */
function ThemePopup(p: { value: string; appearance?: "dark" | "light"; onChange: (v: string) => void }) {
  const themes = allThemes().filter((t) => !p.appearance || t.appearance === p.appearance);
  const labels: Record<string, string> = Object.fromEntries(themes.map((t) => [t.id, t.title]));
  const options = themes.map((t) => t.id);
  if (!labels[p.value]) (options.push(p.value), (labels[p.value] = `${p.value} (not found)`));
  return <Select value={p.value} options={options} labels={labels} onChange={p.onChange} />;
}

