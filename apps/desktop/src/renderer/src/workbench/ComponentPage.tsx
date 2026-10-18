// A component's page in the UI Workbench (docs/48), all of it from the catalog: its doc,
// a matrix of its unions and booleans, a playground with a control per prop, the story
// variants that render it (live), and its props with types, defaults and docs. Kit
// components render from @cmd/ui; the renderer's show through their stories (stand-ins).

import { Component, useEffect, useMemo, useRef, useState, type ComponentType, type ReactNode } from "react";
import * as Kit from "@cmd/ui";
import { Callout, ErrorBoundary, FormRow, FormSection, LinkButton, List, ListRow, ListRowContent, ListRowIcon, NumberField, Prose, SectionHeading, Segmented, Select, Switch, TextField } from "@cmd/ui";
import { loaders, type ComponentInfo, type PropInfo, type StoryInfo, type VariantInfo } from "./catalog/index.ts";
import { Cell } from "./Layered.tsx";
import { argsFor, controlledBy, matrixOf, valuesOf, type Args } from "./args.ts";
import { Themes } from "./Themes.tsx";

const KIT = Kit as unknown as Record<string, ComponentType<Args> | undefined>;

/** How many of the variants that render it show live on its page; the rest are links. */
const LIVE = 6;

export function ComponentPage({ component: c, stories, themes, onOpen }: { component: ComponentInfo; stories: StoryInfo[]; themes?: boolean; onOpen: (story: string, variant?: string) => void }) {
  const C = c.kit ? KIT[c.name] : undefined;
  const { args, missing } = useMemo(() => argsFor(c), [c]);
  const renders = !!C && !missing.length;
  // Every story variant that renders it: its own stories first (beside it or named after it), then the most focused.
  const uses = stories
    .flatMap((s) => s.variants.filter((v) => v.components?.includes(c.id)).map((v) => ({ story: s, variant: v, own: s.components[0] === c.id })))
    .sort((a, b) => Number(b.own) - Number(a.own) || (a.variant.components?.length ?? 0) - (b.variant.components?.length ?? 0));
  const inStories = (
    <Section title="In stories">
      {uses.length ? <Uses uses={uses} onOpen={onOpen} /> : <p className="wb-dim">None yet.</p>}
    </Section>
  );
  return (
    <article className="wb-page">
      <Head title={c.name} file={c.file} doc={c.doc} />
      {renders ? (
        <>
          <Section title="Variants">{themes ? <Themes render={() => <MatrixView c={c} C={C} args={args} />} /> : <MatrixView c={c} C={C} args={args} />}</Section>
          <Section title="Playground">
            <Playground key={c.id} c={c} C={C} initial={args} />
          </Section>
          {inStories}
        </>
      ) : uses.length ? (
        inStories
      ) : (
        <Callout title="This one needs a story">
          {c.kit ? `The UI Workbench can't guess ${missing.map((m) => `\`${m}\``).join(", ")}, and no story renders it. A story beside it shows it with real values.` : "Renderer components take stand-ins for the app (bridge calls, data); a story beside it shows it."}
        </Callout>
      )}
      <Section title="Props">
        <Props props={c.props} />
      </Section>
    </article>
  );
}

type Use = { story: StoryInfo; variant: VariantInfo; own: boolean };

/** The first few variants that render it, live, each with its story's name and note; links to the rest. */
function Uses({ uses, onOpen }: { uses: Use[]; onOpen: (story: string, variant?: string) => void }) {
  const live = uses.slice(0, LIVE);
  const mods = useModules([...new Set(live.map((u) => u.story.id))]);
  return (
    <>
      {live.map(({ story, variant }) => {
        const View = mods[story.id]?.[variant.name] as ComponentType | undefined;
        return (
          <div key={`${story.id}/${variant.name}`} className="wb-section">
            <SectionHeading variant="title" aside={<LinkButton onClick={() => onOpen(story.id, variant.name)}>Show alone</LinkButton>}>
              {story.title} › {variant.name}
            </SectionHeading>
            {variant.doc && <Doc text={variant.doc} />}
            <Cell>
              {typeof View === "function" ? (
                <ErrorBoundary title="This variant stopped working" reloadLabel="Reload">
                  <View />
                </ErrorBoundary>
              ) : null}
            </Cell>
          </div>
        );
      })}
      {uses.length > LIVE && (
        <List>
          {uses.slice(LIVE).map(({ story, variant }) => (
            <ListRow key={`${story.id}/${variant.name}`} onClick={() => onOpen(story.id, variant.name)}>
              <ListRowIcon icon="stack" />
              <ListRowContent title={`${story.title} › ${variant.name}`} place={story.group} />
            </ListRow>
          ))}
        </List>
      )}
    </>
  );
}

/** Story modules by id, loaded on demand. */
function useModules(ids: string[]): Record<string, Record<string, unknown>> {
  const [mods, setMods] = useState<Record<string, Record<string, unknown>>>({});
  const key = ids.join();
  useEffect(() => {
    let live = true;
    for (const id of ids) if (!mods[id]) void loaders[id]?.().then((m) => live && setMods((all) => ({ ...all, [id]: m })), () => {});
    return () => void (live = false);
  }, [key]); // eslint-disable-line react-hooks/exhaustive-deps
  return mods;
}

export function Head({ title, file, doc, children }: { title: ReactNode; file: string; doc?: string; children?: ReactNode }) {
  return (
    <header className="wb-head">
      <div className="wb-head-title">
        <h1>{title}</h1>
        <code>{file}</code>
        {children}
      </div>
      {doc && <Doc text={doc} />}
    </header>
  );
}

/** Paragraphs, with `code` spans. */
export function Doc({ text }: { text: string }) {
  return (
    <Prose>
      {text.split("\n\n").map((p, i) => (
        <p key={i}>{p.split(/(`[^`]+`)/).map((part, j) => (part.startsWith("`") && part.endsWith("`") ? <code key={j}>{part.slice(1, -1)}</code> : part))}</p>
      ))}
    </Prose>
  );
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className="wb-section">
      <SectionHeading>{title}</SectionHeading>
      {children}
    </section>
  );
}

// ── matrix ─────────────────────────────────────────────

const show = (v: unknown) => (typeof v === "string" ? v : String(v));

function MatrixView({ c, C, args }: { c: ComponentInfo; C: ComponentType<Args>; args: Args }) {
  const m = matrixOf(c);
  if (!m.cross && !m.rows.length)
    return (
      <div className="wb-cell">
        <Live c={c} C={C} props={args} />
      </div>
    );
  return (
    <div className="wb-matrix">
      {m.cross && (
        <div className="wb-cell wb-cross" style={{ gridTemplateColumns: `auto repeat(${m.cross.cols.values!.length}, auto)` }}>
          <span className="wb-axis">
            {m.cross.rows.name} \ {m.cross.cols.name}
          </span>
          {m.cross.cols.values!.map((v) => (
            <span key={show(v)} className="wb-axis">
              {show(v)}
            </span>
          ))}
          {m.cross.rows.values!.map((r) => (
            <Row key={show(r)} label={show(r)}>
              {m.cross!.cols.values!.map((v) => (
                <div key={show(v)} className="wb-slot">
                  <Live c={c} C={C} props={{ ...args, [m.cross!.rows.name]: r, [m.cross!.cols.name]: v }} />
                </div>
              ))}
            </Row>
          ))}
        </div>
      )}
      {m.rows.map((p) => (
        <div key={p.name} className="wb-cell wb-axis-row">
          <span className="wb-axis">{p.name}</span>
          {valuesOf(p).map((v) => (
            <figure key={show(v)} className="wb-slot">
              <Live c={c} C={C} props={{ ...args, [p.name]: v }} />
              <figcaption>{show(v)}</figcaption>
            </figure>
          ))}
        </div>
      ))}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <>
      <span className="wb-axis">{label}</span>
      {children}
    </>
  );
}

/** The component with these props; one that follows its own control (a Switch) keeps that state. */
function Live({ c, C, props }: { c: ComponentInfo; C: ComponentType<Args>; props: Args }) {
  const control = controlledBy(c);
  const [value, setValue] = useState(control ? props[control] : undefined);
  const live = control ? { ...props, [control]: value, onChange: (v: unknown) => setValue(v) } : props;
  return (
    <Catch>
      <C {...live} />
    </Catch>
  );
}

/** A cell that broke says so in place, small, instead of taking the page down; a new `retry` tries again. */
class Catch extends Component<{ children: ReactNode; retry?: number }, { error: string | null }> {
  override state = { error: null as string | null };
  static getDerivedStateFromError(e: unknown) {
    return { error: e instanceof Error ? e.message : String(e) };
  }
  override componentDidUpdate(prev: { retry?: number }) {
    if (prev.retry !== this.props.retry && this.state.error) this.setState({ error: null });
  }
  override render() {
    return this.state.error ? <span className="wb-error">{this.state.error}</span> : this.props.children;
  }
}

// ── playground ─────────────────────────────────────────

function Playground({ c, C, initial }: { c: ComponentInfo; C: ComponentType<Args>; initial: Args }) {
  const [args, setArgs] = useState<Args>(initial);
  const [calls, setCalls] = useState<string[]>([]);
  const [version, setVersion] = useState(0);
  const control = controlledBy(c);
  const set = (name: string, v: unknown) => setArgs((a) => ({ ...a, [name]: v }));
  // Callbacks (on…) log their calls; onChange also sets what it controls. Other functions
  // (display, rowKey) return something: they keep their defaults.
  const handlers = useRef(new Map<string, (...a: unknown[]) => void>());
  const live: Args = { ...args };
  for (const p of c.props) {
    if (p.kind !== "function" || !/^on[A-Z]/.test(p.name)) continue;
    if (!handlers.current.has(p.name))
      handlers.current.set(p.name, (...a: unknown[]) => {
        setCalls((l) => [`${p.name}(${a.map((x) => (typeof x === "object" ? "…" : JSON.stringify(x))).join(", ")})`, ...l].slice(0, 6));
        if (p.name === "onChange" && control) set(control, a[0]);
        if (p.name === "onClose" && "open" in args) set("open", false);
      });
    live[p.name] = handlers.current.get(p.name);
  }
  return (
    <div className="wb-playground">
      <div className="wb-cell">
        <Catch retry={version}>
          <C {...live} />
        </Catch>
      </div>
      {calls.length > 0 && (
        <ol className="wb-calls">
          {calls.map((l, i) => (
            <li key={i}>{l}</li>
          ))}
        </ol>
      )}
      <FormSection>
        {c.props
          .filter((p) => p.kind !== "function")
          .map((p) => (
            <FormRow key={p.name} compact title={<code>{p.name}</code>} description={p.doc}>
              <PropControl p={p} value={args[p.name]} onChange={(v) => (set(p.name, v), setVersion((n) => n + 1))} />
            </FormRow>
          ))}
      </FormSection>
    </div>
  );
}

const UNSET = "\u0000unset";

function PropControl({ p, value, onChange }: { p: PropInfo; value: unknown; onChange: (v: unknown) => void }) {
  switch (p.kind) {
    case "union": {
      const opts = (p.values ?? []).map(show);
      const all = p.required ? opts : [UNSET, ...opts];
      const labels = { [UNSET]: "unset" } as Record<string, string>;
      const current = value === undefined ? UNSET : show(value);
      const pick = (v: string) => onChange(v === UNSET ? undefined : p.values!.find((x) => show(x) === v));
      return all.length <= 5 && opts.join("").length < 36 ? <Segmented size="sm" label={p.name} value={current} options={all} labels={labels} onChange={pick} /> : <Select size="sm" label={p.name} value={current} options={all} labels={labels} onChange={pick} />;
    }
    case "boolean":
      return <Switch size="sm" label={p.name} checked={!!value} onChange={onChange} />;
    case "number":
      return <NumberField label={p.name} value={typeof value === "number" ? value : 0} step={0.1} onChange={onChange} />;
    case "string":
    case "node":
      return typeof value === "string" || value === undefined ? <TextField size="sm" value={(value as string | undefined) ?? ""} placeholder={p.default ?? "unset"} onChange={(v) => onChange(v === "" && !p.required ? undefined : v)} /> : <span className="wb-dim">{p.type}</span>;
    default:
      return <code className="wb-dim">{p.type}</code>;
  }
}

// ── props ──────────────────────────────────────────────

function Props({ props }: { props: PropInfo[] }) {
  if (!props.length) return <p className="wb-dim">None.</p>;
  return (
    <dl className="wb-props">
      {props.map((p) => (
        <div key={p.name} className="wb-prop">
          <dt>
            <code className="wb-prop-name">
              {p.name}
              {p.required ? "" : "?"}
            </code>
            <code className="wb-prop-type">{p.type}</code>
            {p.default !== undefined && <code className="wb-prop-default">= {p.default}</code>}
          </dt>
          {p.doc && <dd>{p.doc}</dd>}
        </div>
      ))}
    </dl>
  );
}
