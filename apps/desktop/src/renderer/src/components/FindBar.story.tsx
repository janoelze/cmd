// Workbench stories (pnpm workbench findbar): the kit's FindBar, docked as a second
// toolbar row (PDF, browser, text) and floating over content without a toolbar
// (terminals), at the widths windows get, in each state. Live finds in real text.

import { FindBar, NO_FIND_OPTIONS, ToolbarAddressField, ToolbarButton, ToolbarGroup, Window, WindowBar, WindowBody, WindowFrame, WindowToolbar, type FindOptions, type FindResults } from "@cmd/ui";
import { useMemo, useState, type ReactNode } from "react";

const WIDTHS = [220, 320, 480, 640];
const noop = () => {};

function Win({ width, height = 120, icon, name, selected = true, children }: { width: number; height?: number; icon: string; name: string; selected?: boolean; children: ReactNode }) {
  return (
    <Window selected={selected} style={{ width, height, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <WindowBar icon={icon} name={name} />
        {children}
      </WindowBody>
      <WindowFrame />
    </Window>
  );
}

function BrowserBar() {
  return (
    <WindowToolbar label="Browser">
      <ToolbarGroup>
        <ToolbarButton icon="chevron.left" label="Back" shortcut="⌘[" />
        <ToolbarButton icon="chevron.right" label="Forward" shortcut="⌘]" disabled />
      </ToolbarGroup>
      <ToolbarAddressField value="https://github.com/janoelze/cmd" onSubmit={noop} minWidth={90} />
    </WindowToolbar>
  );
}

/** A bar with its own state, starting from `initial`. */
function Bar(p: { query?: string; results?: FindResults | null; options?: FindOptions; supports?: Partial<Record<keyof FindOptions, boolean>>; floating?: boolean; placeholder?: string }) {
  const [query, setQuery] = useState(p.query ?? "");
  const [options, setOptions] = useState(p.options ?? NO_FIND_OPTIONS);
  return <FindBar query={query} onQuery={setQuery} options={options} onOptions={setOptions} supports={p.supports} results={query === (p.query ?? "") ? (p.results ?? null) : { index: 0, count: 4 }} onStep={noop} onClose={noop} floating={p.floating} placeholder={p.placeholder} />;
}

const Terminal = ({ children }: { children?: ReactNode }) => (
  <div style={{ position: "relative", flex: 1, padding: "8px 10px", font: "12px var(--font-mono)", color: "var(--text-dim)", background: "var(--well)", overflow: "hidden" }}>
    <div>$ pnpm test</div>
    <div>✓ packages/core/test/osc.test.ts (14)</div>
    <div>✓ packages/core/test/search.test.ts (31)</div>
    {children && <div style={{ position: "absolute", top: 6, right: 14, left: 14, display: "flex", justifyContent: "flex-end" }}>{children}</div>}
  </div>
);

const Body = () => <div style={{ flex: 1, background: "var(--well)" }} />;
const Stage = ({ children }: { children: ReactNode }) => <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 16 }}>{children}</div>;
const Row = ({ children }: { children: ReactNode }) => <div style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>{children}</div>;

/** Under a window's own toolbar, at every width: the toggles give way first. */
export const Docked = () => (
  <Stage>
    <Row>
      {WIDTHS.map((w) => (
        <Win key={w} width={w} icon="globe" name="GitHub">
          <BrowserBar />
          <Bar query="search" results={{ index: 2, count: 17 }} supports={{ regex: false, wholeWord: false }} />
          <Body />
        </Win>
      ))}
    </Row>
    <Row>
      {WIDTHS.map((w) => (
        <Win key={w} width={w} icon="doc.text" name="search.ts">
          <Bar query="SearchView" results={{ index: 0, count: 6 }} />
          <Body />
        </Win>
      ))}
    </Row>
  </Stage>
);

/** Over a terminal, which has no toolbar. */
export const Floating = () => (
  <Stage>
    <Row>
      {[360, 640].map((w) => (
        <Win key={w} width={w} height={140} icon="terminal" name="zsh — cmd">
          <Terminal>
            <Bar floating query="test" results={{ index: 0, count: 12, more: true }} />
          </Terminal>
        </Win>
      ))}
    </Row>
  </Stage>
);

/** Every state: empty, counting, searching, no matches, options on, a PDF (no regex), at rest. */
export const States = () => (
  <Stage>
    {(
      [
        ["Empty", {}],
        ["Found", { query: "agent", results: { index: 2, count: 17 } }],
        ["Counted, none current", { query: "agent", results: { index: -1, count: 17 } }],
        ["Searching", { query: "agent", results: { index: -1, count: -1 } }],
        ["No matches", { query: "agnet", results: { index: -1, count: 0 } }],
        ["Options on", { query: "find\\w+", results: { index: 0, count: 3 }, options: { caseSensitive: true, wholeWord: false, regex: true } }],
        ["PDF", { query: "kernel", results: { index: 4, count: 9 }, supports: { regex: false }, placeholder: "Find in PDF" }],
      ] as const
    ).map(([name, p]) => (
      <Row key={name}>
        <Win width={480} height={92} icon="doc.text" name={name}>
          <Bar {...p} />
          <Body />
        </Win>
        <Win width={480} height={92} icon="doc.text" name={`${name}, at rest`} selected={false}>
          <Bar {...p} />
          <Body />
        </Win>
      </Row>
    ))}
  </Stage>
);

const TEXT = `The core owns all state and is a detached process that outlives the UI. Electron main connects to an existing core or spawns one. Closing or reloading the app never kills terminals. Because the core outlives the app, after editing core code an old core may still be serving: core.hello returns a build hash, and the app restarts a mismatched core on launch. Restarting a core is cheap: terminals keep running in the PTY host.`;

/** Type to find in a paragraph: counts, steps, toggles and highlights for real. */
export const Live = () => {
  const [query, setQuery] = useState("core");
  const [options, setOptions] = useState(NO_FIND_OPTIONS);
  const [index, setIndex] = useState(0);
  const ranges = useMemo(() => {
    if (!query) return [];
    let re: RegExp;
    try {
      const src = options.regex ? query : query.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      re = new RegExp(options.wholeWord ? `\\b(?:${src})\\b` : src, options.caseSensitive ? "g" : "gi");
    } catch {
      return [];
    }
    return [...TEXT.matchAll(re)].filter((m) => m[0]).map((m) => [m.index!, m.index! + m[0].length] as const);
  }, [query, options]);
  const current = ranges.length ? ((index % ranges.length) + ranges.length) % ranges.length : -1;
  const parts: ReactNode[] = [];
  let at = 0;
  ranges.forEach(([a, b], i) => {
    parts.push(TEXT.slice(at, a), <mark key={i} className="ui-match" style={i === current ? { background: "color-mix(in srgb, var(--match) 60%, transparent)" } : undefined}>{TEXT.slice(a, b)}</mark>);
    at = b;
  });
  parts.push(TEXT.slice(at));
  return (
    <Stage>
      <Win width={560} height={220} icon="doc.richtext" name="CLAUDE.md">
        <FindBar query={query} onQuery={(q) => (setQuery(q), setIndex(0))} options={options} onOptions={setOptions} results={{ index: current, count: ranges.length }} onStep={(d) => setIndex((i) => i + d)} onClose={() => setQuery("")} />
        <div style={{ flex: 1, padding: "10px 14px", lineHeight: 1.5, color: "var(--text)", background: "var(--well)" }}>{parts}</div>
      </Win>
    </Stage>
  );
};
