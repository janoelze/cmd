// The gallery: one page per family of components, each showing its variants,
// sizes and states, plus the tokens, every theme side by side, and patterns
// (whole views built only from the kit). Adding a component means adding its
// specimen here.

import { Fragment, useEffect, useRef, useState, type CSSProperties, type ReactNode } from "react";
import {
  Badge,
  Button,
  ButtonGroup,
  Callout,
  Card,
  Chip,
  Checkbox,
  CodeBlock,
  ConfirmDialog,
  Dialog,
  EmptyState,
  FeatureList,
  FormRow,
  FormSection,
  Icon,
  IconButton,
  Kbd,
  KeyValue,
  LinkButton,
  ListRow,
  ListSection,
  ListValue,
  Menu,
  NumberField,
  Popover,
  PageDots,
  Panel,
  Prose,
  PanelBody,
  PanelHeader,
  PanelSummary,
  Progress,
  ProgressRing,
  RadioGroup,
  ResetButton,
  SearchField,
  SecretField,
  SectionHeading,
  Segmented,
  Select,
  Separator,
  SheetHeader,
  Spacer,
  Spinner,
  StatusDot,
  Switch,
  Tabs,
  TextArea,
  TextField,
  Toast,
  Toolbar,
  toast,
  type DotState,
} from "../src/index.ts";
import { allThemes, applyTheme, currentTheme, themeFor, themeVars, useTheme } from "../src/themes/registry.ts";

type PageId = "tokens" | "themes" | "buttons" | "choices" | "fields" | "status" | "forms" | "content" | "overlays" | "patterns";
const PAGES: { id: PageId; title: string; icon: string }[] = [
  { id: "tokens", title: "Tokens", icon: "paintpalette" },
  { id: "themes", title: "Themes", icon: "square.grid.2x2" },
  { id: "buttons", title: "Buttons", icon: "rectangle" },
  { id: "choices", title: "Choices", icon: "checkmark" },
  { id: "fields", title: "Fields", icon: "textformat" },
  { id: "status", title: "Status", icon: "info.circle" },
  { id: "forms", title: "Forms", icon: "gearshape" },
  { id: "content", title: "Content", icon: "doc.text" },
  { id: "overlays", title: "Overlays", icon: "macwindow" },
  { id: "patterns", title: "Patterns", icon: "rectangle.3.group" },
];

const params = new URLSearchParams(location.search);

export function Gallery() {
  const theme = useTheme();
  const [page, setPage] = useState<PageId>(() => (PAGES.some((p) => p.id === params.get("page")) ? (params.get("page") as PageId) : "buttons"));
  useEffect(() => {
    const asked = params.get("theme");
    applyTheme((asked && themeFor(asked)) || currentTheme());
  }, []);
  useEffect(() => {
    const u = new URL(location.href);
    u.searchParams.set("page", page);
    u.searchParams.set("theme", theme.id);
    history.replaceState(null, "", u);
  }, [page, theme]);
  const themes = allThemes();
  return (
    <div className="g">
      <nav className="g-side">
        <div className="g-brand">
          cmd UI <span>@cmd/ui</span>
        </div>
        {PAGES.map((p) => (
          <button key={p.id} className="g-nav" aria-current={p.id === page ? "page" : undefined} onClick={() => setPage(p.id)}>
            <Icon name={p.icon} size={12} />
            {p.title}
          </button>
        ))}
      </nav>
      <main className="g-main">
        <Toolbar label="Gallery">
          <Select
            label="Theme"
            value={theme.id}
            width={200}
            options={themes.map((t) => ({ value: t.id, label: `${t.title}${t.appearance === "light" ? " (light)" : ""}` }))}
            onChange={(id) => applyTheme(themeFor(id)!)}
          />
          <ButtonGroup joined label="Step through themes">
            <IconButton variant="default" icon="chevron.left" label="Previous theme" onClick={() => applyTheme(themes[(themes.indexOf(theme) - 1 + themes.length) % themes.length]!)} />
            <IconButton variant="default" icon="chevron.right" label="Next theme" onClick={() => applyTheme(themes[(themes.indexOf(theme) + 1) % themes.length]!)} />
          </ButtonGroup>
          <Spacer />
          <span className="g-dim">
            {theme.appearance} · {themes.length} themes
          </span>
        </Toolbar>
        <div className="g-scroll">
          <div className="g-page">{PAGE[page]()}</div>
        </div>
      </main>
    </div>
  );
}

function PageDotsDemo() {
  const [at, setAt] = useState(1);
  return (
    <>
      <Row label="buttons">
        <PageDots count={5} current={at} onSelect={setAt} />
      </Row>
      <Row label="sm">
        <PageDots count={8} current={at} onSelect={setAt} size="sm" />
      </Row>
      <Row label="static">
        <PageDots count={3} current={at % 3} />
      </Row>
    </>
  );
}

function Spec({ title, code, note, children, plain }: { title: string; code?: string; note?: ReactNode; children: ReactNode; plain?: boolean }) {
  return (
    <section className="g-spec">
      <div className="g-spec-head">
        <h2>{title}</h2>
        {code && <code>{code}</code>}
      </div>
      {note && <p className="g-note">{note}</p>}
      {plain ? children : <div className="g-stage">{children}</div>}
    </section>
  );
}

function Row({ label, children }: { label?: string; children: ReactNode }) {
  return (
    <div className="g-row">
      {label && <span className="g-row-label">{label}</span>}
      {children}
    </div>
  );
}

const PAGE: Record<PageId, () => ReactNode> = {
  tokens: () => <TokensPage />,
  themes: () => <ThemesPage />,
  buttons: () => <ButtonsPage />,
  choices: () => <ChoicesPage />,
  fields: () => <FieldsPage />,
  status: () => <StatusPage />,
  forms: () => <FormsPage />,
  content: () => <ContentPage />,
  overlays: () => <OverlaysPage />,
  patterns: () => <PatternsPage />,
};

// ── tokens ─────────────────────────────────────────────

const THEME_COLORS = ["bg", "bg-sidebar", "bg-elevated", "well", "text", "text-dim", "icon", "accent", "link", "match", "state-needs", "state-done", "state-working", "state-idle"];
const DERIVED = ["bg-hover", "bg-selected", "separator", "control-bg", "control-edge", "control-hover", "control-thumb", "field-bg", "group-bg", "code-bg", "danger", "warning", "success", "on-accent"];

function Swatches({ names }: { names: string[] }) {
  return (
    <div className="g-swatches">
      {names.map((n) => (
        <div key={n} className="g-swatch">
          <span className="g-swatch-chip" style={{ background: `var(--${n})` }} />
          <code>--{n}</code>
        </div>
      ))}
    </div>
  );
}

function TokensPage() {
  return (
    <>
      <h1>Tokens</h1>
      <p className="g-lede">
        A theme sets the colours in the first group (<code>ThemeColors</code>); everything else is derived from them in <code>tokens.css</code>, and a
        theme's <code>vars</code> can override any of it. Components use tokens only.
      </p>
      <Spec title="Theme colours" code="themes/types.ts" plain>
        <Swatches names={THEME_COLORS} />
      </Spec>
      <Spec title="Derived" code="tokens.css" plain>
        <Swatches names={DERIVED} />
      </Spec>
      <Spec title="Type scale" note="Controls use --text-md, body --text-base, descriptions and status lines --text-sm, badges and caps headings --text-xs.">
        <div className="g-type">
          {(["2xs", "xs", "sm", "md", "base", "lg", "xl"] as const).map((s) => (
            <Fragment key={s}>
              <code>--text-{s}</code>
              <span style={{ fontSize: `var(--text-${s})` }}>Agents, terminals and windows</span>
            </Fragment>
          ))}
          <code>--font-mono</code>
          <span style={{ font: "var(--text-md) var(--font-mono)" }}>~/src/cmd $ pnpm ui</span>
        </div>
      </Spec>
      <Spec title="Control heights and radii">
        <div className="g-boxes">
          {(["control-h-sm", "control-h", "control-h-lg"] as const).map((h) => (
            <div key={h} className="g-box">
              <span style={{ height: `var(--${h})`, borderRadius: "var(--radius)" }} />
              <span>--{h}</span>
            </div>
          ))}
          <Separator vertical />
          {(["radius-xs", "radius-sm", "radius", "radius-md", "radius-lg", "radius-xl"] as const).map((r) => (
            <div key={r} className="g-box">
              <span style={{ height: 40, borderRadius: `var(--${r})` }} />
              <span>--{r}</span>
            </div>
          ))}
        </div>
      </Spec>
    </>
  );
}

// ── themes ─────────────────────────────────────────────

function ThemesPage() {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("grid");
  return (
    <>
      <h1>Themes</h1>
      <p className="g-lede">
        Every built-in theme at once: each card is a <code>.ui-theme</code> subtree with the theme's tokens on it. Click one to switch the gallery to it.
      </p>
      <div className="g-themes">
        {allThemes().map((t) => (
          <div key={t.id} className="g-theme ui-theme" style={themeVars(t) as CSSProperties} onClick={() => applyTheme(t)}>
            <div className="g-theme-name">
              <StatusDot state="working" />
              {t.title}
              <Spacer />
              <Badge size="sm">{t.appearance}</Badge>
            </div>
            <div className="g-theme-well">
              <Row>
                <Button variant="primary" size="sm">
                  Save
                </Button>
                <Button size="sm">Cancel</Button>
                <Switch size="sm" checked={on} onChange={setOn} label="On" />
              </Row>
              <Segmented size="sm" value={seg} onChange={setSeg} options={["grid", "strip", "focus"]} labels={{ grid: "Grid", strip: "Strip", focus: "Focus" }} />
              <TextField size="sm" value="" placeholder="Search" icon="magnifyingglass" fill onChange={() => {}} />
              <Row>
                <Badge tone="accent">accent</Badge>
                <Badge tone="success">ok</Badge>
                <Badge tone="warning">needs</Badge>
                <Badge tone="danger">failed</Badge>
              </Row>
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

// ── buttons ────────────────────────────────────────────

function ButtonsPage() {
  const [busy, setBusy] = useState(false);
  const [bold, setBold] = useState(true);
  return (
    <>
      <h1>Buttons</h1>
      <p className="g-lede">
        One recipe, four variants. Primary is the accent and the thing Enter does: one per view. Ghost has no fill until hovered, for bars and quiet
        actions. Danger destroys. Everything else is default.
      </p>
      <Spec title="Button" code="<Button variant size icon busy>">
        {(["default", "primary", "danger", "ghost"] as const).map((v) => (
          <Row key={v} label={v}>
            <Button variant={v} size="sm">
              Small
            </Button>
            <Button variant={v}>Restore</Button>
            <Button variant={v} size="lg">
              Large
            </Button>
            <Button variant={v} icon="arrow.clockwise">
              Refresh
            </Button>
            <Button variant={v} disabled>
              Disabled
            </Button>
          </Row>
        ))}
        <Row label="states">
          <Button busy={busy} onClick={() => (setBusy(true), setTimeout(() => setBusy(false), 1500))}>
            {busy ? "Saving…" : "Busy for 1.5s"}
          </Button>
          <Button pressed={bold} onClick={() => setBold(!bold)} icon="textformat">
            Toggle
          </Button>
          <Button trailing="chevron.down">Opens a menu</Button>
          <Button icon="plus" aria-label="Add" />
        </Row>
      </Spec>
      <Spec title="IconButton" code="<IconButton icon label shortcut>" note="An icon alone, always with a label: it becomes the tooltip and the accessible name. Ghost in bars; default beside other controls.">
        <Row label="ghost">
          <IconButton icon="sidebar.left" label="Toggle Sidebar" shortcut="⌘S" />
          <IconButton icon="square.grid.2x2" label="Grid" pressed />
          <IconButton icon="rectangle.split.3x1" label="Strip" />
          <IconButton icon="magnifyingglass" label="Search" size="sm" />
          <IconButton icon="trash" label="Delete" disabled />
        </Row>
        <Row label="default">
          <IconButton variant="default" icon="plus" label="Add" />
          <IconButton variant="default" icon="ellipsis" label="More" />
          <IconButton variant="default" icon="doc.on.doc" label="Copy" />
        </Row>
        <Row label="default, sm (bars)">
          <Segmented
            size="sm"
            label="View"
            value="grid"
            onChange={() => {}}
            options={[
              { value: "focus", icon: "rectangle", tip: "Focus" },
              { value: "grid", icon: "square.grid.2x2", tip: "Grid" },
              { value: "strip", icon: "rectangle.split.3x1", tip: "Strip" },
            ]}
          />
          <IconButton variant="default" size="sm" icon="plus" label="New…" />
        </Row>
      </Spec>
      <Spec title="ButtonGroup" code="<ButtonGroup joined | align>" note="Joined: one control (Back | Forward, − | +). Spaced: a row of actions with the standard gap; align end for a footer.">
        <Row label="joined">
          <ButtonGroup joined>
            <IconButton variant="default" icon="chevron.left" label="Back" />
            <IconButton variant="default" icon="chevron.right" label="Forward" />
          </ButtonGroup>
          <ButtonGroup joined>
            <Button>Day</Button>
            <Button>Week</Button>
            <Button>Month</Button>
          </ButtonGroup>
          <ButtonGroup joined>
            <Button icon="arrow.clockwise">Run now</Button>
            <Button icon="chevron.down" aria-label="More run options" />
          </ButtonGroup>
        </Row>
        <ButtonGroup align="end">
          <Button>Cancel</Button>
          <Button variant="primary">Send</Button>
        </ButtonGroup>
      </Spec>
      <Spec title="LinkButton" code="<LinkButton tone>" note="An action inside running text or a dim note.">
        <p className="g-note" style={{ margin: 0 }}>
          The widget's folder is <code>~/.cmd/widgets/weather</code> · <LinkButton>Show in Finder</LinkButton> · <LinkButton tone="dim">Copy path</LinkButton> ·{" "}
          <LinkButton tone="danger">Delete</LinkButton>
        </p>
      </Spec>
    </>
  );
}

// ── choices ────────────────────────────────────────────

function ChoicesPage() {
  const [on, setOn] = useState(true);
  const [checks, setChecks] = useState({ a: true, b: false, c: true });
  const [radio, setRadio] = useState("tab");
  const [seg, setSeg] = useState("auto");
  const [view, setView] = useState("grid");
  const [tab, setTab] = useState("changes");
  const [tab2, setTab2] = useState("general");
  const [sel, setSel] = useState("5m");
  const all = Object.values(checks);
  return (
    <>
      <h1>Choices</h1>
      <p className="g-lede">
        Switch applies at once; Checkbox sits in a list or beside a sentence. Segmented for a few short choices side by side, RadioGroup when each needs
        explaining, Select for many. Tabs choose which view is shown.
      </p>
      <Spec title="Switch" code="<Switch checked onChange label>">
        <Row>
          <Switch checked={on} onChange={setOn} label="Notifications" />
          <Switch checked={!on} onChange={(v) => setOn(!v)} label="Off" />
          <Switch size="sm" checked={on} onChange={setOn} label="Small" />
          <Switch checked={false} disabled onChange={() => {}} label="Disabled" />
        </Row>
      </Spec>
      <Spec title="Checkbox" code="<Checkbox checked mixed description>">
        <Checkbox checked={all.every(Boolean)} mixed={!all.every(Boolean) && all.some(Boolean)} onChange={(v) => setChecks({ a: v, b: v, c: v })}>
          All permissions
        </Checkbox>
        <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingLeft: 21 }}>
          <Checkbox checked={checks.a} onChange={(v) => setChecks({ ...checks, a: v })} description="api.github.com, api.open-meteo.com">
            Network
          </Checkbox>
          <Checkbox checked={checks.b} onChange={(v) => setChecks({ ...checks, b: v })} description="Read files under ~/src">
            Files
          </Checkbox>
          <Checkbox checked={checks.c} onChange={(v) => setChecks({ ...checks, c: v })}>
            Environment variables
          </Checkbox>
        </div>
        <Checkbox checked disabled onChange={() => {}}>
          Disabled
        </Checkbox>
      </Spec>
      <Spec title="RadioGroup" code="<RadioGroup options descriptions>">
        <RadioGroup
          value={radio}
          onChange={setRadio}
          options={["tab", "window", "split"]}
          labels={{ tab: "In a new tab", window: "In a new window", split: "Beside the current one" }}
          descriptions={{ window: "Uses the window layout of the current Space." }}
        />
      </Spec>
      <Spec title="Segmented" code="<Segmented options labels size>">
        <Row label="text">
          <Segmented value={seg} onChange={setSeg} options={["auto", "dark", "light"]} labels={{ auto: "Auto", dark: "Dark", light: "Light" }} />
          <Segmented size="sm" value={seg} onChange={setSeg} options={["auto", "dark", "light"]} labels={{ auto: "Auto", dark: "Dark", light: "Light" }} />
        </Row>
        <Row label="icons">
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "grid", icon: "square.grid.2x2", tip: "Grid" },
              { value: "strip", icon: "rectangle.split.3x1", tip: "Strip" },
              { value: "focus", icon: "rectangle", tip: "Focus" },
            ]}
          />
          <Segmented
            size="sm"
            value={view}
            onChange={setView}
            options={[
              { value: "focus", icon: "rectangle", tip: "Focus" },
              { value: "grid", icon: "square.grid.2x2", tip: "Grid" },
              { value: "strip", icon: "rectangle.split.3x1", tip: "Strip" },
              { value: "canvas", icon: "rectangle.3.group", tip: "Canvas" },
            ]}
          />
          <Segmented
            value={view}
            onChange={setView}
            options={[
              { value: "grid", icon: "square.grid.2x2", label: "Grid" },
              { value: "strip", icon: "rectangle.split.3x1", label: "Strip" },
              { value: "focus", icon: "rectangle", label: "Focus", disabled: true },
            ]}
          />
        </Row>
        <Row label="fill">
          <div style={{ width: 320 }}>
            <Segmented fill value={seg} onChange={setSeg} options={["auto", "dark", "light"]} labels={{ auto: "Auto", dark: "Dark", light: "Light" }} />
          </div>
        </Row>
      </Spec>
      <Spec title="Tabs" code="<Tabs items variant>" note="Arrow keys move between tabs. A badge is a count; a dot means something there wants you.">
        <Tabs
          value={tab}
          onChange={setTab}
          items={[
            { id: "changes", label: "Changes" },
            { id: "settings", label: "Settings" },
            { id: "files", label: "Files", badge: 6 },
            { id: "health", label: "Health", badge: "dot", tone: "warning" },
          ]}
        />
        <Tabs
          variant="underline"
          value={tab2}
          onChange={setTab2}
          items={[
            { id: "general", label: "General", icon: "gearshape" },
            { id: "appearance", label: "Appearance", icon: "paintpalette" },
            { id: "keyboard", label: "Keyboard", icon: "keyboard" },
          ]}
        />
      </Spec>
      <Spec title="Select" code="<Select options labels>" note="A native popup menu, styled as a control.">
        <Row>
          <Select
            value={sel}
            onChange={setSel}
            options={["1m", "5m", "15m", "1h", "off"]}
            labels={{ "1m": "Every minute", "5m": "Every 5 minutes", "15m": "Every 15 minutes", "1h": "Every hour", off: "Never" }}
          />
          <Select size="sm" value={sel} onChange={setSel} options={["1m", "5m", "15m"]} />
          <Select disabled value="x" onChange={() => {}} options={["x"]} labels={{ x: "Disabled" }} />
        </Row>
      </Spec>
    </>
  );
}

// ── fields ─────────────────────────────────────────────

function FieldsPage() {
  const [text, setText] = useState("Berlin");
  const [committed, setCommitted] = useState("claude --resume");
  const [q, setQ] = useState("");
  const [n, setN] = useState(14);
  const [opacity, setOpacity] = useState(0.85);
  const [secret, setSecret] = useState(true);
  const [prompt, setPrompt] = useState("");
  return (
    <>
      <h1>Fields</h1>
      <p className="g-lede">
        All fields sit in the well with a hairline and take the accent halo on focus. Live fields report every keystroke; commit fields (
        <code>onCommit</code>) report on Enter or blur and revert on Escape, for values that apply at once.
      </p>
      <Spec title="TextField" code="<TextField value onChange | onCommit>">
        <Row label="sizes">
          <TextField size="sm" value={text} onChange={setText} width={140} />
          <TextField value={text} onChange={setText} width={160} />
          <TextField size="lg" value={text} onChange={setText} width={180} />
        </Row>
        <Row label="commit">
          <TextField code value={committed} onCommit={setCommitted} width={240} />
          <span className="g-dim">committed: {committed}</span>
        </Row>
        <Row label="adornments">
          <TextField value="" placeholder="https://" icon="globe" onChange={() => {}} width={220} />
          <TextField value="320" end="px" onChange={() => {}} width={100} />
        </Row>
        <Row label="states">
          <TextField value="not a url" invalid onChange={() => {}} width={160} />
          <TextField value="Disabled" disabled onChange={() => {}} width={160} />
          <TextField value="" placeholder="Placeholder" onChange={() => {}} width={160} />
        </Row>
      </Spec>
      <Spec title="SearchField" code="<SearchField value onChange status>" note="Escape clears; a clear button once there is text; status (a ring while indexing) at the end.">
        <Row>
          <SearchField value={q} onChange={setQ} width={260} />
          <SearchField value="claude" onChange={() => {}} width={260} status={<ProgressRing value={0.6} size={12} />} />
        </Row>
      </Spec>
      <Spec title="TextArea" code="<TextArea onSubmit autoGrow bare>">
        <TextArea value={prompt} onChange={setPrompt} placeholder="What should change? ⌘↩ sends" autoGrow={6} onSubmit={() => (toast(`Sent: ${prompt || "(empty)"}`), setPrompt(""))} />
        <TextArea bare rows={2} value="" onChange={() => {}} placeholder="Describe a widget… (bare: the field is the view)" />
      </Spec>
      <Spec title="NumberField" code="<NumberField min max step unit>" note="↑/↓ step it, Shift ×10. Clamped; Escape reverts.">
        <Row>
          <NumberField value={n} min={8} max={32} unit="px" onChange={setN} />
          <NumberField value={opacity} min={0} max={1} step={0.05} onChange={setOpacity} />
          <NumberField value={3} disabled onChange={() => {}} />
        </Row>
      </Spec>
      <Spec title="SecretField" code="<SecretField set hint onSave>" note="Never shows the secret, and the field never moves: what happens to it is attached to its right, as one control. Save (or nothing when live: it saves on paste), Checking while an onSave promise runs, and once stored its last characters with a status (Accepted, Not checked, Rejected) and Remove. Click a stored secret to replace it.">
        <Row>
          <SecretField set={secret} hint="…f3a9" placeholder="sk-ant-…" onSave={(v) => setSecret(v != null)} />
          <SecretField set={false} placeholder="Any key but “bad”" onSave={(v) => new Promise((ok, fail) => setTimeout(() => (v === "bad" ? fail(new Error("refused")) : ok(null)), 800))} />
          <SecretField set={false} live placeholder="Live: paste any key but “bad”" onSave={(v) => new Promise((ok, fail) => setTimeout(() => (v === "bad" ? fail(new Error("refused")) : ok(null)), 800))} />
        </Row>
      </Spec>
    </>
  );
}

// ── status ─────────────────────────────────────────────

/** An agent's life, to show the dot's transitions: [state, ms]. */
const LIFE: [DotState, number][] = [["idle", 1400], ["working", 3600], ["needs", 3000], ["working", 2400], ["unseen", 3000], ["done", 2000], ["off", 1400]];

function StatusPage() {
  const [p, setP] = useState(0.35);
  const [life, setLife] = useState(0);
  useEffect(() => {
    const t = setTimeout(() => setLife((i) => (i + 1) % LIFE.length), LIFE[life]![1]);
    return () => clearTimeout(t);
  }, [life]);
  useEffect(() => {
    const t = setInterval(() => setP((v) => (v >= 1 ? 0 : v + 0.05)), 300);
    return () => clearInterval(t);
  }, []);
  const states: DotState[] = ["needs", "unseen", "working", "done", "idle", "off"];
  return (
    <>
      <h1>Status</h1>
      <Spec title="StatusDot" code="<StatusDot state>" note="A 2×2 dot matrix. The agent states, as the sidebar shows them, each its own glyph; and tones for anything else. Entering needs pops, entering unseen bursts.">
        <Row label="agents">
          {states.map((s) => (
            <span key={s} className="g-row" style={{ gap: 6 }}>
              <StatusDot state={s} /> <span className="g-dim">{s}</span>
            </span>
          ))}
        </Row>
        <Row label="lifecycle">
          <span className="g-row" style={{ gap: 6 }}>
            <StatusDot state={LIFE[life]![0]} /> <span className="g-dim">{LIFE[life]![0]}</span>
          </span>
        </Row>
        <Row label="tones">
          {(["neutral", "accent", "success", "warning", "danger"] as const).map((s) => (
            <span key={s} className="g-row" style={{ gap: 6 }}>
              <StatusDot state={s} size="sm" /> <span className="g-dim">{s}</span>
            </span>
          ))}
        </Row>
      </Spec>
      <Spec title="Badge" code="<Badge tone size solid>">
        {(["neutral", "accent", "success", "warning", "danger"] as const).map((t) => (
          <Row key={t} label={t}>
            <Badge tone={t}>Default</Badge>
            <Badge tone={t} size="sm">
              3
            </Badge>
            <Badge tone={t} size="sm" solid>
              12
            </Badge>
          </Row>
        ))}
      </Spec>
      <Spec title="Kbd" code="<Kbd keys plain>">
        <Row>
          <Kbd keys={["⌘", "K"]} />
          <Kbd keys="⌘⇧P" />
          <Kbd keys="⌘E" plain />
        </Row>
      </Spec>
      <Spec title="PageDots" code="<PageDots count current onSelect?>" note="Pagination: a dot per page, the current one a wider, lighter pill. With onSelect the dots are buttons.">
        <PageDotsDemo />
      </Spec>
      <Spec title="Progress, Spinner, ProgressRing">
        <Row label="bar">
          <Progress value={p} />
          <Progress value={0.7} tone="success" />
          <Progress value={0.4} tone="danger" />
          <Progress label="Indexing" />
        </Row>
        <Row label="spinner">
          <Spinner />
          <Spinner size={16} />
          <span className="g-row" style={{ gap: 6, color: "var(--text-dim)" }}>
            <Spinner size={11} /> Working…
          </span>
        </Row>
        <Row label="ring">
          <ProgressRing value={p} />
          <ProgressRing value={0.75} size={18} />
        </Row>
      </Spec>
    </>
  );
}

// ── forms ──────────────────────────────────────────────

function FormsPage() {
  const [s, setS] = useState({ notify: true, appearance: "auto", font: 14, shell: "/bin/zsh", refresh: "5m", city: "Berlin" });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS({ ...s, [k]: v });
  return (
    <>
      <h1>Forms</h1>
      <p className="g-lede">
        The Settings window's layout as components: a <code>FormSection</code> is a heading and a group box; each <code>FormRow</code> puts its text on the left
        and its control in a right-hand column that lines up down the page.
      </p>
      <FormSection title="General">
        <FormRow title="Notifications" description="When an agent finishes or needs you and the window isn't in front." tip="notify.enabled">
          <Switch checked={s.notify} onChange={(v) => set("notify", v)} label="Notifications" />
        </FormRow>
        <FormRow title="Appearance" accessory={s.appearance !== "auto" && <ResetButton onClick={() => set("appearance", "auto")} />}>
          <Segmented value={s.appearance} onChange={(v) => set("appearance", v)} options={["auto", "dark", "light"]} labels={{ auto: "Auto", dark: "Dark", light: "Light" }} />
        </FormRow>
        <FormRow title="Font size" description="Terminals and the editor." accessory={<Badge size="sm" tone="accent">New</Badge>}>
          <NumberField value={s.font} min={8} max={32} unit="px" onChange={(v) => set("font", v)} />
        </FormRow>
        <FormRow title="Shell" description="Applies to new terminals." note={s.shell.includes(" ") ? "Paths with spaces need quoting." : undefined} noteTone="warning">
          <TextField code value={s.shell} onCommit={(v) => set("shell", v)} />
        </FormRow>
      </FormSection>
      <FormSection title="Widget" aside={<LinkButton>Reset all</LinkButton>}>
        <FormRow title="Refresh" description="How often its data runs.">
          <Select value={s.refresh} onChange={(v) => set("refresh", v)} options={["1m", "5m", "1h"]} labels={{ "1m": "Every minute", "5m": "Every 5 minutes", "1h": "Every hour" }} />
        </FormRow>
        <FormRow title="City">
          <TextField value={s.city} onCommit={(v) => set("city", v)} />
        </FormRow>
        <FormRow title="API key" description="Stored in the macOS keychain, not in settings.json.">
          <SecretField set hint="…9c2e" onSave={() => {}} />
        </FormRow>
        <FormRow title="Prompt" description="Stacked: the control under the text, full width." stacked>
          <TextArea value="" onChange={() => {}} placeholder="Anything the widget should know" rows={2} />
        </FormRow>
      </FormSection>
      <FormSection title="Shortcuts">
        {[
          ["New Terminal", "⌘T"],
          ["Command Palette", "⌘K"],
          ["Toggle Sidebar", "⌘S"],
        ].map(([t, k]) => (
          <FormRow key={t} compact title={t}>
            <Kbd keys={k!} />
          </FormRow>
        ))}
      </FormSection>
    </>
  );
}

// ── content ────────────────────────────────────────────

function ContentPage() {
  const [shown, setShown] = useState(true);
  return (
    <>
      <h1>Content</h1>
      <Spec title="Callout" code="<Callout tone title actions banner>" note="Above content: something failed, needs doing, or is worth knowing. Danger is red, warning the attention orange.">
        {shown ? (
          <Callout tone="danger" title="The data isn't coming" actions={<Button size="sm">Fix</Button>} onDismiss={() => setShown(false)}>
            fetch https://api.open-meteo.com failed 3 times in a row: 503 Service Unavailable.
          </Callout>
        ) : (
          <Button size="sm" onClick={() => setShown(true)}>
            Show again
          </Button>
        )}
        <Callout tone="warning" actions={<LinkButton>Reload</LinkButton>}>
          This file changed on disk since you opened it.
        </Callout>
        <Callout tone="success">All checks passed.</Callout>
        <Callout tone="accent" title="Tip">
          ⌘E switches between a widget and its editor.
        </Callout>
        <Callout>The core restarted; terminals kept running.</Callout>
      </Spec>
      <Spec title="Callout banner" note="Full width along a view's edge." plain>
        <div style={{ borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
          <Callout banner tone="warning" actions={<><Button size="sm">Keep mine</Button><Button size="sm">Reload</Button></>}>
            notes.md changed on disk.
          </Callout>
          <div style={{ padding: 16, background: "var(--well)", font: "var(--text-md) var(--font-mono)" }}># Notes</div>
        </div>
        <div style={{ borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
          <div style={{ height: 60, background: "var(--well)" }} />
          <Callout banner="bottom" compact tone="danger" actions={<><LinkButton>Fix</LinkButton><LinkButton>Details</LinkButton></>}>
            Data keeps failing: fetch failed (503)
          </Callout>
        </div>
      </Spec>
      <Spec title="EmptyState" code="<EmptyState icon title action compact>">
        <EmptyState icon="safari" title="Blank page" action={<Button>Open a URL</Button>}>
          Type an address, or drop a link here.
        </EmptyState>
        <Separator />
        <EmptyState compact icon="clock.arrow.circlepath" title="No versions yet">
          Each change you ask for is kept here, so you can go back.
        </EmptyState>
      </Spec>
      <Spec title="Panel, ListSection, ListRow, Chip" code="<Panel> <PanelHeader title onTitleClick actions> <ListSection title count> <ListRow icon light title detail tone end hover>" note="Lists like the Navigator's and the file browser's sidebar. The header's title opens a menu and its actions show on hover; a row's light takes the icon's place, and its end gives way to its hover actions.">
        <ListSpecimen />
      </Spec>
      <Spec
        title="SheetHeader, FeatureList, Prose"
        code="<SheetHeader icon title subtitle> · <FeatureList items> · <Prose>"
        note="A sheet's greeting, at --text-display once per screen; what something offers, one feature a line; and running text styled by its elements (h2, h3 with <small>, lists, code, links, hr), for release notes and help."
      >
        <Card>
          <SheetHeader icon="sparkles" title="Connect an AI provider" subtitle="Magic widgets and notification summaries use it." />
        </Card>
        <Card>
          <FeatureList
            items={[
              { icon: "rectangle.3.group", title: "One desk", description: "Terminals, agents, a browser and an editor as windows." },
              { icon: "terminal", title: "Agents in your terminals", description: "The one that needs you is on top." },
            ]}
          />
        </Card>
        <Card>
          <Prose>
            <h3>
              0.14.0 <small>5 October 2026</small>
            </h3>
            <p>Read PDFs in cmd, and four new built-in widgets.</p>
            <Badge size="sm" tone="success">
              Improved
            </Badge>
            <ul>
              <li>
                <strong>Built-in widgets.</strong> Commands lists what your terminals ran; <code>cmd open</code> opens files.
              </li>
              <li>
                Window outlines no longer spill into the gap. <a href="#">Read more</a>
              </li>
            </ul>
          </Prose>
        </Card>
      </Spec>
      <Spec title="CodeBlock" code="<CodeBlock tone maxHeight>">
        <CodeBlock>{`$ deno check data.ts\nCheck file:///widgets/weather/data.ts\nOK`}</CodeBlock>
        <CodeBlock tone="danger">{`error: Uncaught (in promise) TypeError: fetch failed\n    at data.ts:12:15`}</CodeBlock>
      </Spec>
      <Spec title="KeyValue" code="<KeyValue items mono>">
        <KeyValue
          mono
          items={[
            ["Network", "api.open-meteo.com"],
            ["Files", "none"],
            ["Env", "OPENWEATHER_KEY"],
          ]}
        />
      </Spec>
      <Spec title="Card, SectionHeading, Separator, Toolbar" plain>
        <Card>
          <SectionHeading aside="3 running">Agents</SectionHeading>
          <div style={{ height: 8 }} />
          <SectionHeading variant="title">A title heading</SectionHeading>
          <div style={{ height: 8 }} />
          <SectionHeading tone="warning">Needs you</SectionHeading>
        </Card>
        <div style={{ borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
          <Toolbar>
            <ButtonGroup joined>
              <IconButton variant="default" icon="chevron.left" label="Back" />
              <IconButton variant="default" icon="chevron.right" label="Forward" />
            </ButtonGroup>
            <IconButton icon="arrow.clockwise" label="Reload" shortcut="⌘R" />
            <TextField value="https://github.com/janoelze/cmd" fill onChange={() => {}} size="sm" />
            <Separator vertical />
            <IconButton icon="arrow.up.forward.app" label="Open in browser" />
          </Toolbar>
          <div style={{ height: 60, background: "var(--well)" }} />
        </div>
      </Spec>
    </>
  );
}

// ── overlays ───────────────────────────────────────────

function OverlaysPage() {
  const menuAnchor = useRef<HTMLButtonElement>(null);
  const popAnchor = useRef<HTMLButtonElement>(null);
  const [menu, setMenu] = useState(false);
  const [pop, setPop] = useState(false);
  const [dialog, setDialog] = useState(false);
  const [confirm, setConfirm] = useState(false);
  const [divided, setDivided] = useState(false);
  const [welcome, setWelcome] = useState(false);
  const [space, setSpace] = useState("work");
  const [msg, setMsg] = useState("");
  return (
    <>
      <h1>Overlays</h1>
      <p className="g-lede">
        Native menus and confirms (<code>cmd.contextMenu</code>, <code>cmd.confirm</code>) stay native. These are for what needs more than text: a menu with
        icons and details, a popover card, a sheet with fields, a toast with an action.
      </p>
      <Spec title="Menu" code="<Menu anchor items>" note="Arrow keys, Enter, type to jump. null is a separator, a string a heading.">
        <Row>
          <Button ref={menuAnchor} trailing="chevron.up.chevron.down" onClick={() => setMenu(!menu)}>
            {space === "work" ? "Work" : space === "home" ? "Home" : "Side project"}
          </Button>
          <Menu
            anchor={menuAnchor}
            open={menu}
            onClose={() => setMenu(false)}
            items={[
              "Spaces",
              { label: "Work", detail: "4 windows · 2 agents", icon: "terminal", checked: space === "work", shortcut: "⌃1", onSelect: () => setSpace("work") },
              { label: "Home", detail: "1 window", icon: "house", checked: space === "home", shortcut: "⌃2", onSelect: () => setSpace("home") },
              { label: "Side project", icon: "sparkles", checked: space === "side", shortcut: "⌃3", onSelect: () => setSpace("side") },
              null,
              { label: "New Space…", icon: "plus", onSelect: () => toast("New Space") },
              { label: "Delete Space", icon: "trash", danger: true, onSelect: () => toast("Deleted", { tone: "danger", action: { label: "Undo", run: () => toast("Restored") } }) },
            ]}
          />
        </Row>
      </Spec>
      <Spec title="Popover" code="<Popover anchor open onClose>">
        <Row>
          <Button ref={popAnchor} icon="info.circle" onClick={() => setPop(!pop)}>
            Core details
          </Button>
          <Popover anchor={popAnchor} open={pop} onClose={() => setPop(false)} width={280}>
            <div style={{ padding: "10px 12px", display: "flex", flexDirection: "column", gap: 8 }}>
              <SectionHeading aside={<StatusDot state="unseen" size="sm" />}>Core</SectionHeading>
              <KeyValue
                items={[
                  ["Build", "4f670fc"],
                  ["Uptime", "3h 12m"],
                  ["Terminals", "7"],
                ]}
              />
              <ButtonGroup align="end">
                <Button size="sm">Restart</Button>
              </ButtonGroup>
            </div>
          </Popover>
        </Row>
      </Spec>
      <Spec
        title="Dialog and ConfirmDialog"
        code="<Dialog title actions aside height divided?> · <ConfirmDialog danger>"
        note="Sheets share one shape: centred, the kit's title row (or a SheetHeader when it greets), the body's controls 12px apart, and a footer with the aside (status, a checkbox, PageDots) across from the actions."
      >
        <Row>
          <Button onClick={() => setDialog(true)}>Send Feedback…</Button>
          <Button variant="danger" onClick={() => setConfirm(true)}>
            Delete Space…
          </Button>
          <Button onClick={() => setDivided(true)}>What's New</Button>
          <Button onClick={() => setWelcome(true)}>Welcome</Button>
        </Row>
        <Dialog
          open={divided}
          onClose={() => setDivided(false)}
          title="What's New"
          width={560}
          position="center"
          divided
          aside="You're on cmd 0.14.1"
          actions={
            <Button variant="primary" onClick={() => setDivided(false)}>
              Done
            </Button>
          }
        >
          <Prose>
            {Array.from({ length: 4 }, (_, i) => (
              <Fragment key={i}>
                {i > 0 && <hr />}
                <h3>
                  0.14.{4 - i} <small>5 October 2026</small>
                </h3>
                <Badge size="sm" tone="accent">
                  New
                </Badge>
                <ul>
                  <li>
                    <strong>PDF viewer.</strong> PDFs open in their own window, with search and <code>⌘F</code>.
                  </li>
                  <li>Release notes scroll between the title and the actions.</li>
                </ul>
              </Fragment>
            ))}
          </Prose>
        </Dialog>
        <Dialog
          open={welcome}
          onClose={() => setWelcome(false)}
          width={480}
          height={560}
          position="center"
          label="Welcome"
          aside={<PageDots count={2} current={0} />}
          actions={
            <Button variant="primary" onClick={() => setWelcome(false)}>
              Get Started
            </Button>
          }
        >
          <SheetHeader icon="command.square.fill" title="Welcome to cmd" subtitle="Terminals and coding agents, side by side." />
          <FeatureList
            items={[
              { icon: "rectangle.3.group", title: "One desk", description: "Terminals, agents, a browser and an editor as windows." },
              { icon: "wand.and.stars", title: "Magic widgets", description: "Ask for a window and an agent builds it." },
            ]}
          />
        </Dialog>
        <Dialog
          open={dialog}
          onClose={() => setDialog(false)}
          title="Send Feedback"
          width={480}
          position="center"
          aside={
            <Checkbox checked onChange={() => {}}>
              Include version and system info
            </Checkbox>
          }
          actions={
            <>
              <Button onClick={() => setDialog(false)}>Cancel</Button>
              <Button variant="primary" disabled={!msg.trim()} onClick={() => (setDialog(false), setMsg(""), toast("Thanks!", { tone: "success", icon: "checkmark.circle.fill" }))}>
                Send
              </Button>
            </>
          }
        >
          <Segmented fill value="idea" onChange={() => {}} options={["bug", "idea", "other"]} labels={{ bug: "Bug", idea: "Idea", other: "Other" }} />
          <TextArea value={msg} onChange={setMsg} placeholder="What happened, or what would you like?" rows={4} />
        </Dialog>
        <ConfirmDialog
          open={confirm}
          danger
          title="Delete “Side project”?"
          confirm="Delete"
          onCancel={() => setConfirm(false)}
          onConfirm={() => (setConfirm(false), toast("Space deleted", { tone: "danger" }))}
        >
          Its 3 windows close. Terminals in it are ended.
        </ConfirmDialog>
      </Spec>
      <Spec title="Toast" code="toast(message, { tone, action }) · <Toaster/>">
        <Row>
          <Button onClick={() => toast("Copied path")}>Plain</Button>
          <Button onClick={() => toast("Widget rebuilt", { tone: "success", icon: "checkmark.circle.fill" })}>Success</Button>
          <Button onClick={() => toast("Window closed", { action: { label: "Undo", run: () => toast("Reopened") } })}>With action</Button>
        </Row>
        <Toast tone="warning" icon="exclamationmark.triangle.fill" onDismiss={() => {}}>
          Terminal resized to 80×24 (in place, as a specimen)
        </Toast>
      </Spec>
      <Spec title="Tooltip" code='data-tip="…" data-tip-key="⌘K"' note="Any element with data-tip; installTooltips() once per window.">
        <Row>
          <Button data-tip="Opens the command palette" data-tip-key="⌘K">
            Hover me
          </Button>
          <IconButton icon="gearshape" label="Settings" shortcut="⌘," />
        </Row>
      </Spec>
    </>
  );
}

// ── patterns ───────────────────────────────────────────

function PatternsPage() {
  const [tab, setTab] = useState("changes");
  const [text, setText] = useState("");
  const [refresh, setRefresh] = useState("300");
  const [units, setUnits] = useState("metric");
  const [compact, setCompact] = useState(false);
  return (
    <>
      <h1>Patterns</h1>
      <p className="g-lede">Whole views from the kit alone. The Magic widget editor, rebuilt: tabs in a toolbar, form rows for its settings, versions as a list.</p>
      <div className="g-window">
        <Toolbar>
          <Tabs
            value={tab}
            onChange={setTab}
            items={[
              { id: "changes", label: "Changes" },
              { id: "settings", label: "Settings" },
              { id: "files", label: "Files" },
              { id: "health", label: "Health", badge: "dot", tone: "danger" },
            ]}
          />
          <Spacer />
          <span className="g-dim" style={{ display: "inline-flex", alignItems: "center", gap: 6 }}>
            <Spinner size={11} /> Working…
          </span>
          <Button size="sm" data-tip="Back to the widget" data-tip-key="⌘E">
            Done
          </Button>
        </Toolbar>
        <div className="g-window-body">
          {tab === "changes" && (
            <>
              <FormSection title="Ask for a change" plain>
                <TextArea value={text} onChange={setText} placeholder="Show the next 3 days, not just today" autoGrow={6} onSubmit={() => setText("")} submitOnEnter />
                <div className="g-row" style={{ marginTop: 8 }}>
                  <span className="g-dim">⏎ to send · the widget stays as it is until the change works</span>
                  <Spacer />
                  <Button>Fix problems</Button>
                  <Button variant="primary" disabled={!text.trim()}>
                    Change
                  </Button>
                </div>
              </FormSection>
              <FormSection title="Versions" aside="files edited since the last version" plain>
                {[
                  { n: 3, p: "Show the next 3 days, not just today", ok: true, at: "2 min ago", current: true },
                  { n: 2, p: "Use °C and a smaller font", ok: false, at: "1 h ago" },
                  { n: 1, p: "Weather in Berlin", ok: true, at: "yesterday" },
                ].map((v) => (
                  <div key={v.n} className="g-version">
                    <span className="g-shot" />
                    <span className="g-version-text">
                      <span style={{ fontWeight: v.current ? 600 : 400 }}>{v.p}</span>
                      <span>
                        <StatusDot size="sm" state={v.ok ? "success" : "warning"} /> {v.ok ? "checks passed" : "2 problems left"} · {v.at}
                      </span>
                    </span>
                    {v.current ? <Badge>shown</Badge> : <Button size="sm">Restore</Button>}
                  </div>
                ))}
              </FormSection>
            </>
          )}
          {tab === "settings" && (
            <>
              <FormSection title="Data">
                <FormRow title="Refresh" description="How often data.ts runs.">
                  <Select
                    value={refresh}
                    onChange={setRefresh}
                    options={["60", "300", "3600", "0"]}
                    labels={{ "60": "Every minute", "300": "Every 5 minutes", "3600": "Every hour", "0": "Only when opened" }}
                  />
                </FormRow>
              </FormSection>
              <FormSection title="Widget">
                <FormRow title="City" tip="city">
                  <TextField value="Berlin" onCommit={() => {}} />
                </FormRow>
                <FormRow title="Units">
                  <Segmented value={units} onChange={setUnits} options={["metric", "imperial"]} labels={{ metric: "°C", imperial: "°F" }} />
                </FormRow>
                <FormRow title="Compact" description="One line, no forecast.">
                  <Switch checked={compact} onChange={setCompact} label="Compact" />
                </FormRow>
                <FormRow title="Days">
                  <NumberField value={3} min={1} max={7} onChange={() => {}} />
                </FormRow>
                <FormRow title="API token">
                  <SecretField set={false} placeholder="Paste a token" onSave={() => {}} />
                </FormRow>
              </FormSection>
              <FormSection title="Permissions" aside={<LinkButton>Edit manifest</LinkButton>}>
                <div style={{ padding: "10px 14px" }}>
                  <KeyValue
                    mono
                    items={[
                      ["Network", "api.open-meteo.com"],
                      ["Files", "none"],
                    ]}
                  />
                </div>
              </FormSection>
            </>
          )}
          {tab === "files" && (
            <EmptyState compact icon="folder" title="weather/" action={<ButtonGroup><Button size="sm">Show in Finder</Button><Button size="sm">Copy Path</Button></ButtonGroup>}>
              view.tsx, data.ts, manifest.json
            </EmptyState>
          )}
          {tab === "health" && (
            <>
              <Callout tone="danger" title="Failing (3 times in a row)" actions={<Button size="sm" variant="primary">Fix</Button>}>
                The agent gets the error and the widget's files.
              </Callout>
              <CodeBlock tone="danger">{`TypeError: fetch failed\n    at data.ts:12:15`}</CodeBlock>
            </>
          )}
        </div>
      </div>
    </>
  );
}

function ListSpecimen() {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height: 300, display: "flex", borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
      <Panel>
        <PanelHeader title="Commands" onTitleClick={() => {}} actions={<IconButton size="sm" icon="trash" label="Clear" />}>
          <PanelSummary tone="danger">1 failed</PanelSummary>
        </PanelHeader>
        <PanelBody>
          <ListSection title="Running" count={1}>
            <ListRow icon="terminal" light="working" mono title="pnpm dev" detail="Running · 4 min" end={<Chip hue={200}>cmd</Chip>} />
          </ListSection>
          <ListSection title="Finished" count={3} open={open} onToggle={() => setOpen((o) => !o)}>
            <ListRow icon="terminal" light="danger" mono title="pnpm test" detail="Failed · exit 1 · 12 s" tone="danger" end={<><Chip hue={200}>cmd</Chip><ListValue>2m</ListValue></>} hover={<IconButton size="sm" icon="arrow.clockwise" label="Run Again" />} />
            <ListRow icon="terminal" mono title="git status" detail="0.2 s" selected end={<ListValue>5m</ListValue>} />
            <ListRow icon="bell" title="One line, with a place" place="~/src/cmd" end={<ListValue strong>84%</ListValue>} />
          </ListSection>
        </PanelBody>
      </Panel>
    </div>
  );
}
