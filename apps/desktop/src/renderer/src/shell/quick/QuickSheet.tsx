// The Quick Command sheet (docs/58): what a Quick Command asks for ({{ask:…}} as a field,
// {{pick:…}} as a choice), what it will type, run or open with those values, and Run. A
// command that asks before running shows the same sheet with nothing to fill in.

import { useEffect, useRef, useState } from "react";
import type { QuickCommand, QuickContext, QuickResolved } from "@cmd/protocol";
import { Button, Callout, CodeBlock, Dialog, FormRow, Select, Stack, Text, TextField } from "@cmd/ui";
import { cmd } from "../../lib/bridge.ts";
import type { QuickPending } from "./quick.ts";

/** What a missing variable needs, said to the person. */
const NEEDS: Record<string, string> = {
  file: "Select a file first.",
  selection: "Select some text first.",
  clipboard: "The clipboard is empty.",
  branch: "The folder isn't in a git repository.",
  repo: "The folder isn't in a git repository.",
  url: "Select a browser window first.",
};

const WHERE: Record<string, string> = { type: "Types", terminal: "Runs in a new terminal", open: "Opens" };

/** Where it goes, in a few words: "Types into Claude", "Runs in a new terminal". */
function whereText(c: QuickCommand, ctx: QuickContext, r: QuickResolved): string {
  const t = c.target ?? "type";
  if (t !== "type") return WHERE[t]!;
  if (!ctx.paneId) return WHERE.terminal!;
  return r.mode === "text" ? "Sends to the agent" : "Types into the terminal";
}

export function QuickSheet({
  open = true,
  pending,
  onClose,
  resolve = (values) => cmd.call("quick.resolve", { id: pending.command.id, context: pending.context, values }),
  run,
}: {
  /** False while it fades out (Presence). */
  open?: boolean;
  pending: QuickPending;
  onClose: () => void;
  /** What it would do with these values (a story passes its own). */
  resolve?: (values: Record<string, string>) => Promise<QuickResolved>;
  run: (values: Record<string, string>) => Promise<void>;
}) {
  const { command, resolved: first } = pending;
  const [values, setValues] = useState<Record<string, string>>(() => Object.fromEntries(first.asks.map((a) => [a.name, a.kind === "ask" ? a.default : a.options[0]!])));
  const [resolved, setResolved] = useState(first);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstField = useRef<HTMLInputElement>(null);

  useEffect(() => firstField.current?.focus(), []);
  useEffect(() => {
    let live = true;
    const t = setTimeout(() => void resolve(values).then((r) => live && setResolved(r), () => {}), 80);
    return () => ((live = false), clearTimeout(t));
  }, [values]); // eslint-disable-line react-hooks/exhaustive-deps

  const canRun = !busy && resolved.text !== null;
  const go = async () => {
    if (!canRun) return;
    setBusy(true);
    setError(null);
    try {
      await run(values);
      onClose();
    } catch (err) {
      setError((err as Error).message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ""));
      setBusy(false);
    }
  };
  const set = (name: string, v: string) => setValues((x) => ({ ...x, [name]: v }));

  return (
    <Dialog
      open={open}
      onClose={onClose}
      window={{ icon: "bolt", name: command.name }}
      width={520}
      position="center"
      divided
      label={command.name}
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant={command.confirm ? "danger" : "primary"} disabled={!canRun} busy={busy} data-tip="Run" data-tip-key="↩" onClick={() => void go()}>
            Run
          </Button>
        </>
      }
    >
      {command.description && <Text tone="dim">{command.description}</Text>}
      <form
        onSubmit={(e) => {
          e.preventDefault();
          void go();
        }}
      >
        {first.asks.map((a, i) => (
          <FormRow key={a.name} compact title={a.name}>
            {a.kind === "ask" ? (
              <TextField ref={i === 0 ? firstField : undefined} fill value={values[a.name] ?? ""} placeholder={a.default || undefined} onChange={(v) => set(a.name, v)} />
            ) : (
              <Select value={values[a.name] ?? a.options[0]!} options={a.options} onChange={(v) => set(a.name, v)} label={a.name} />
            )}
          </FormRow>
        ))}
        {/* Enter in a field runs it. */}
        <button type="submit" hidden />
      </form>
      {resolved.text !== null ? (
        <Stack gap={1}>
          <Text tone="dim" size="sm">
            {whereText(command, pending.context, resolved)}
          </Text>
          <CodeBlock>{resolved.text}</CodeBlock>
        </Stack>
      ) : (
        <Callout tone="warning" title={`Needs ${resolved.missing.map((m) => `{{${m}}}`).join(", ")}`}>
          {NEEDS[resolved.missing[0]!] ?? "It can't run here."}
        </Callout>
      )}
      {error && (
        <Callout tone="danger" title="Couldn't run it">
          {error}
        </Callout>
      )}
    </Dialog>
  );
}
