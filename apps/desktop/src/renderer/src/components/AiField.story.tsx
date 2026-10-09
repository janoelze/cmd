// Workbench stories (pnpm workbench aifield): the kit's AiField in every state and
// size, and Live, which runs a pretend request (thinking, then done or an error)
// so the motion between states can be watched and interrupted with Stop.
import { useRef, useState, type ReactNode } from "react";
import { AiField, LinkButton, type AiFieldProps, type AiState, type Size } from "@cmd/ui";

const noop = () => {};

/** An AiField that keeps its own text. */
function Field(p: Partial<AiFieldProps> & { initial?: string }) {
  const [value, setValue] = useState(p.initial ?? "");
  return <AiField placeholder="Ask for a change: “double-time hats”, “darker bass”" {...p} value={value} onChange={setValue} onSubmit={p.onSubmit ?? noop} />;
}

const Column = ({ children, width = 460 }: { children: ReactNode; width?: number }) => <div style={{ width, display: "flex", flexDirection: "column", gap: 22 }}>{children}</div>;
const Label = ({ children }: { children: ReactNode }) => <div style={{ font: "11px var(--font-ui)", color: "var(--text-dim)", marginBottom: 6, textTransform: "uppercase", letterSpacing: 0.4 }}>{children}</div>;
const ask = "double-time hats and make the bass darker";

export const States = () => (
  <Column>
    {(
      [
        ["Idle", { state: "idle" }, ""],
        ["Idle, typed", { state: "idle" }, ask],
        ["Thinking", { state: "thinking", onStop: noop }, ask],
        ["Done", { state: "done" }, ""],
        ["Error", { state: "error", error: "Couldn't make that play: nope is not defined", action: <LinkButton>Try Again</LinkButton> }, ask],
      ] as [string, Partial<AiFieldProps>, string][]
    ).map(([label, p, initial]) => (
      <div key={label}>
        <Label>{label}</Label>
        <Field {...p} initial={initial} />
      </div>
    ))}
  </Column>
);

export const Sizes = () => (
  <Column>
    {(["sm", "md", "lg"] as Size[]).map((size) => (
      <div key={size} style={{ display: "flex", flexDirection: "column", gap: 10 }}>
        <Label>{size}</Label>
        <Field size={size} initial={ask} />
        <Field size={size} initial={ask} state="thinking" onStop={noop} />
      </div>
    ))}
  </Column>
);

export const Multiline = () => (
  <Column>
    <Field initial={"Make it feel like a late-night drive:\n- slower, around 90 bpm\n- a warm pad with long release\n- hats only every other bar"} />
    <Field initial={"Make it feel like a late-night drive:\n- slower, around 90 bpm\n- a warm pad with long release\n- hats only every other bar"} state="thinking" onStop={noop} />
  </Column>
);

/** A pretend request: thinking, then done (or an error for prompts with "fail"); Stop works. */
export const Live = () => {
  const [value, setValue] = useState("");
  const [state, setState] = useState<AiState>("idle");
  const [error, setError] = useState<string | null>(null);
  const [history, setHistory] = useState<string[]>(["add a pad with slow chords", "double-time hats"]);
  const timers = useRef<ReturnType<typeof setTimeout>[]>([]);
  const later = (ms: number, fn: () => void) => timers.current.push(setTimeout(fn, ms));
  const stop = () => {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setState("idle");
  };
  const submit = (prompt: string) => {
    setHistory((h) => [prompt, ...h.filter((x) => x !== prompt)]);
    setState("thinking");
    setError(null);
    later(3000, () => {
      if (/fail/i.test(prompt)) return setState("error"), setError("Couldn't make that play: nope is not defined");
      setState("done");
      setValue("");
    });
  };
  return (
    <Column>
      <AiField
        value={value}
        onChange={(v) => (setValue(v), state === "error" && setState("idle"))}
        onSubmit={submit}
        onStop={stop}
        state={state}
        error={error}
        history={history}
        action={<LinkButton onClick={() => submit(value)}>Try Again</LinkButton>}
        placeholder="Ask for a change (try one with “fail”)"
        autoFocus
      />
    </Column>
  );
};
