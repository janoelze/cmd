// Fields: all sit in the well with a hairline and take the accent halo on focus. Live
// fields report every keystroke; commit fields (onCommit) report on Enter or blur and
// revert on Escape, for values that apply at once. ShortcutField as Settings → Keyboard
// Shortcuts uses it: click a key to record it again, its corner badge removes it.
import { useState, type ReactNode } from "react";
import { Pill, PillRow } from "./button.tsx";
import { ClearButton, NumberField, SearchField, ShortcutField, TextArea, TextField } from "./fields.tsx";
import { FormRow, FormSection } from "./layout.tsx";
import { ProgressRing } from "./status.tsx";

const Row = ({ label, children }: { label: string; children: ReactNode }) => (
  <div style={{ display: "flex", alignItems: "center", gap: "var(--space-3)" }}>
    <span style={{ width: 96, color: "var(--text-dim)", fontSize: "var(--text-sm)" }}>{label}</span>
    {children}
  </div>
);
const Rows = ({ children }: { children: ReactNode }) => <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>{children}</div>;

/** Sizes, a commit field (Enter or blur commits, Escape reverts), an icon and a unit inside, and the states. */
export const Text = () => {
  const [text, setText] = useState("Berlin");
  const [committed, setCommitted] = useState("claude --resume");
  return (
    <Rows>
      <Row label="sizes">
        <TextField size="sm" value={text} onChange={setText} width={140} />
        <TextField value={text} onChange={setText} width={160} />
        <TextField size="lg" value={text} onChange={setText} width={180} />
      </Row>
      <Row label="commit">
        <TextField code value={committed} onCommit={setCommitted} width={240} />
        <span style={{ color: "var(--text-dim)" }}>committed: {committed}</span>
      </Row>
      <Row label="inside">
        <TextField value="" placeholder="https://" icon="globe" onChange={() => {}} width={220} />
        <TextField value="320" end="px" onChange={() => {}} width={100} />
        <TextField value={text} end={text && <ClearButton onClick={() => setText("")} />} onChange={setText} width={160} />
      </Row>
      <Row label="states">
        <TextField value="not a url" invalid onChange={() => {}} width={160} />
        <TextField value="Disabled" disabled onChange={() => {}} width={160} />
        <TextField value="" placeholder="Placeholder" onChange={() => {}} width={160} />
      </Row>
    </Rows>
  );
};

/** Escape clears; a clear button once there is text; a status at the end (a ring while indexing). */
export const Search = () => {
  const [q, setQ] = useState("");
  return (
    <Rows>
      <SearchField value={q} onChange={setQ} width={260} />
      <SearchField value="claude" onChange={() => {}} width={260} status={<ProgressRing value={0.6} size={12} />} />
    </Rows>
  );
};

/** A prompt that grows to six lines and sends with ⌘↩; and bare, where the field is the view. */
export const Area = () => {
  const [prompt, setPrompt] = useState("");
  const [sent, setSent] = useState("");
  return (
    <div style={{ width: 420, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <TextArea value={prompt} onChange={setPrompt} placeholder="What should change? ⌘↩ sends" autoGrow={6} onSubmit={() => (setSent(prompt), setPrompt(""))} />
      {sent && <span style={{ color: "var(--text-dim)" }}>Sent: {sent}</span>}
      <TextArea bare rows={2} value="" onChange={() => {}} placeholder="Describe a widget… (bare: the field is the view)" />
    </div>
  );
};

/** Pills under a field put a snippet into it: a command's variables. */
export const Snippets = () => {
  const [body, setBody] = useState("git push -u origin ");
  return (
    <div style={{ width: 420, display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <TextArea code rows={2} value={body} onChange={setBody} />
      <PillRow>
        {["folder", "file", "selection", "branch", "date"].map((v) => (
          <Pill key={v} mono data-tip={`Insert {{${v}}}`} onClick={() => setBody((b) => `${b}{{${v}}}`)}>
            {v}
          </Pill>
        ))}
        <Pill mono disabled>
          clipboard
        </Pill>
      </PillRow>
    </div>
  );
};

/** ↑/↓ step it, Shift ×10; clamped; Escape reverts. A unit, a fraction, disabled. */
export const Numbers = () => {
  const [n, setN] = useState(14);
  const [o, setO] = useState(0.85);
  return (
    <div style={{ display: "flex", gap: "var(--space-3)" }}>
      <NumberField value={n} min={8} max={32} unit="px" onChange={setN} />
      <NumberField value={o} min={0} max={1} step={0.05} onChange={setO} />
      <NumberField value={3} disabled onChange={() => {}} />
    </div>
  );
};

/** One command with two shortcuts (click one to record), one with none. */
export const Shortcuts = () => {
  const [keys, setKeys] = useState(["⌘K", "⇧⌘P"]);
  const [rec, setRec] = useState<number | undefined>(undefined);
  return (
    <div style={{ width: 520 }}>
      <FormSection>
        <FormRow title="Command Palette" compact>
          <ShortcutField keys={keys} recording={rec} onRecord={(i) => setRec(rec === i ? undefined : i)} onRemove={(i) => setKeys(keys.filter((_, j) => j !== i))} />
        </FormRow>
        <FormRow title="New Terminal" compact>
          <ShortcutField keys={[]} onRecord={() => {}} onRemove={() => {}} />
        </FormRow>
      </FormSection>
    </div>
  );
};
