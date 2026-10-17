// Settings → Quick Commands (docs/58): the person's commands in the file's order, each with
// where it goes and its shortcut, moved up and down, and an editor for one: its name, body
// (with Insert Variable and the body's mistakes under it), target, workspace, shortcut and
// whether it asks first, in the page's place (Esc or the title bar's back chevron returns to the list).
// Saved through the core (quick.save), which keeps the file's comments; looks again when the
// window gets focus, as the file may have been edited by hand.

import { useEffect, useRef, useState } from "react";
import { parseQuick, QUICK_VARIABLES, type QuickCommand, type QuickList, type QuickTarget, type Workspace } from "@cmd/protocol";
import { Button, Callout, FormActions, FormRow, FormSection, IconButton, Inline, Segmented, Select, ShortcutField, Stack, Switch, Text, TextArea, TextField } from "@cmd/ui";
import { COMMAND_BY_ID, norm, prettyAccelerator } from "../../../shared/commands.ts";
import { cmd } from "../lib/bridge.ts";
import { acceleratorOf, usableShortcut, useKeybindings } from "../lib/keybindings.ts";

const TARGETS: { value: QuickTarget; label: string }[] = [
  { value: "type", label: "Type" },
  { value: "terminal", label: "New Terminal" },
  { value: "open", label: "Open" },
];
const TARGET_TEXT: Record<QuickTarget, string> = {
  type: "Typed into the selected terminal, or the agent in it; else run in a new terminal.",
  terminal: "Run in a new terminal in the workspace.",
  open: "A URL or path, opened in a cmd window.",
};
const ASKS = { "ask:name": "Asks for a value when it runs: {{ask:name=default}}", "pick:name=a,b": "Asks for one of a few: {{pick:env=dev,prod}}" };

/** An error from main or the core without Electron's prefix. */
const message = (e: unknown) => String((e as Error)?.message ?? e).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

/** A workspace's name from its folder; the folder when cmd doesn't know it (any more). */
const workspaceName = (root: string, all: Workspace[]) => all.find((w) => w.root === root)?.name ?? root;

const where = (q: QuickCommand) => ({ type: "Type", terminal: "New Terminal", open: "Open" })[q.target ?? "type"];

export function QuickCommands({
  newAsk = 0,
  onSubpage,
}: {
  /** Bumped by Session → New Quick Command…: the editor opens empty. */
  newAsk?: number;
  /** The editor is open (its title, and back to the list), for the window's title bar; null: the list. */
  onSubpage?: (sub: { title: string; back: () => void } | null) => void;
}) {
  const [list, setList] = useState<QuickList | null>(null);
  const [workspaces, setWorkspaces] = useState<Workspace[]>([]);
  const [editing, setEditing] = useState<QuickCommand | "new" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keys = useKeybindings();
  const look = () => {
    void cmd.call("quick.list", {}).then(setList, (e: unknown) => setError(message(e)));
    void cmd.call("workspace.list", { closed: true }).then(setWorkspaces, () => {});
  };
  useEffect(() => {
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, []);
  useEffect(() => void (newAsk > 0 && setEditing("new")), [newAsk]);
  useEffect(() => {
    onSubpage?.(editing ? { title: editing === "new" ? "New Quick Command" : editing.name, back: () => setEditing(null) } : null);
    return () => onSubpage?.(null);
  }, [editing]); // eslint-disable-line react-hooks/exhaustive-deps
  const act = (p: Promise<unknown>) => void p.then(look, (e: unknown) => setError(message(e)));

  const commands = list?.commands ?? [];
  if (editing)
    return (
      <QuickEditor
        key={editing === "new" ? "new" : editing.id}
        command={editing === "new" ? null : editing}
        others={commands.filter((q) => editing === "new" || q.id !== editing.id)}
        workspaces={workspaces}
        taken={keys.bindings}
        onClose={() => setEditing(null)}
        onSave={(c) => cmd.call("quick.save", { command: c }).then(() => (look(), setEditing(null)))}
        onDelete={(id) => cmd.call("quick.remove", { id }).then(() => (look(), setEditing(null)))}
      />
    );
  return (
    <>
      {error && (
        <Callout tone="danger" title="Couldn't change Quick Commands">
          {error}
        </Callout>
      )}
      {list?.error && (
        <Callout tone="warning" title="quick-commands.json can't be read">
          {list.error}. Showing the last commands it could read; fix the file to change them here.
        </Callout>
      )}
      {!!list?.problems?.length && <Callout tone="warning" title="Some entries aren't Quick Commands">{list.problems.join(" · ")}</Callout>}
      <FormSection title="Quick Commands">
        {list && !commands.length && <FormRow title="None yet" description="Save the commands and prompts you type every day. Add one with New Quick Command…" />}
        {commands.map((q, i) => (
          <FormRow
            key={q.id}
            tip={q.id}
            title={q.name}
            description={
              <>
                {where(q)}
                {q.workspace && ` · ${workspaceName(q.workspace, workspaces)}`} · <code>{q.body}</code>
              </>
            }
            accessory={
              <Inline gap={0.5}>
                <IconButton size="sm" icon="chevron.up" label="Move Up" disabled={i === 0 || !!list?.error} onClick={() => act(cmd.call("quick.move", { id: q.id, before: commands[i - 1]!.id }))} />
                <IconButton size="sm" icon="chevron.down" label="Move Down" disabled={i === commands.length - 1 || !!list?.error} onClick={() => act(cmd.call("quick.move", { id: q.id, before: commands[i + 2]?.id ?? null }))} />
              </Inline>
            }
          >
            <Inline gap={1.5}>
              {q.keys?.[0] && <Text tone="dim">{q.keys.map((k) => prettyAccelerator(k)).join(" ")}</Text>}
              <Button size="sm" disabled={!!list?.error} onClick={() => (setError(null), setEditing(q))}>
                Edit…
              </Button>
            </Inline>
          </FormRow>
        ))}
      </FormSection>
      <FormActions hint="Run them from Session → Quick Commands, the palette or “cmd quick run”.">
        <Button disabled={!list || !!list.error} onClick={() => (setError(null), setEditing("new"))}>
          New Quick Command…
        </Button>
        <Button disabled={!list?.path || !commands.length} onClick={() => list && cmd.openSettingsFile(list.path)}>
          Edit quick-commands.json…
        </Button>
      </FormActions>
    </>
  );
}

/** One Quick Command's editor, a page in the list's place. */
export function QuickEditor({
  command,
  others,
  workspaces = [],
  taken,
  onClose,
  onSave,
  onDelete,
}: {
  /** null: a new one. */
  command: QuickCommand | null;
  /** The rest, whose shortcuts it can't have. */
  others: QuickCommand[];
  /** Open and recent ones, which it can be kept to. */
  workspaces?: Workspace[];
  /** App commands' shortcuts (keybindings): theirs to keep. */
  taken: Record<string, string[]>;
  onClose: () => void;
  onSave: (c: Omit<QuickCommand, "id"> & { id?: string }) => Promise<unknown>;
  onDelete: (id: string) => Promise<unknown>;
}) {
  const [name, setName] = useState(command?.name ?? "");
  const [description, setDescription] = useState(command?.description ?? "");
  const [body, setBody] = useState(command?.body ?? "");
  const [target, setTarget] = useState<QuickTarget>(command?.target ?? "type");
  const [submit, setSubmit] = useState(command?.submit ?? true);
  const [cwd, setCwd] = useState(command?.cwd ?? "");
  const [keys, setKeys] = useState<string[]>(command?.keys ?? []);
  const [confirm, setConfirm] = useState(command?.confirm ?? false);
  const [workspace, setWorkspace] = useState(command?.workspace ?? "");
  const [recording, setRecording] = useState<number | undefined>(undefined);
  const [note, setNote] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const nameRef = useRef<HTMLInputElement>(null);
  const root = useRef<HTMLDivElement>(null);
  // It starts at the top, wherever the list was scrolled to, with the name to type.
  useEffect(() => {
    for (let el = root.current?.parentElement; el; el = el.parentElement) if (el.scrollHeight > el.clientHeight && getComputedStyle(el).overflowY !== "visible") el.scrollTop = 0;
    nameRef.current?.focus();
  }, []);

  const problems = [...parseQuick(body).errors, ...parseQuick(cwd).errors];
  const canSave = !busy && !!name.trim() && !!body.trim() && !problems.length;

  // Recording: the menu's shortcuts are off, so every key lands here.
  useEffect(() => {
    if (recording === undefined) return;
    cmd.recordShortcut(true);
    const stop = () => setRecording(undefined);
    const onKey = (e: KeyboardEvent) => {
      e.preventDefault();
      e.stopPropagation();
      const acc = acceleratorOf(e);
      if (!acc) return;
      if (acc === "Escape") return stop();
      if (!usableShortcut(acc)) return setNote(`${prettyAccelerator(acc)} alone would be typed; add ⌘, ⌃ or ⌥.`);
      const app = Object.entries(taken).find(([, ks]) => ks.some((k) => norm(k) === norm(acc)))?.[0];
      if (app) return setNote(`${prettyAccelerator(acc)} is ${COMMAND_BY_ID.get(app)?.label.replace(/…$/, "") ?? app}’s. Pick another, or change that one in Keyboard Shortcuts.`);
      // Kept to different workspaces, two can share a shortcut: only one is in the menu at a time.
      const mine = others.find((q) => (!q.workspace || !workspace || q.workspace === workspace) && q.keys?.some((k) => norm(k) === norm(acc)));
      if (mine) return setNote(`${prettyAccelerator(acc)} is “${mine.name}”’s already.`);
      setNote(null);
      setKeys((ks) => {
        const next = [...ks];
        next.splice(recording, 1, acc);
        return next.filter((k, i) => next.findIndex((x) => norm(x) === norm(k)) === i);
      });
      stop();
    };
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("blur", stop);
    return () => {
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("blur", stop);
      cmd.recordShortcut(false);
    };
  }, [recording, taken, others, workspace]);

  // Esc goes back (unless a menu or the recorder had it); ⌘↵ saves.
  const saveRef = useRef<() => void>(() => {});
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.defaultPrevented || recording !== undefined) return;
      if (e.key === "Escape") return (e.preventDefault(), onClose());
      if (e.key === "Enter" && e.metaKey) return (e.preventDefault(), saveRef.current());
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [recording, onClose]);

  /** Insert a variable where the cursor is in the body. */
  const insert = (v: string) => {
    const el = bodyRef.current;
    const at = el ? el.selectionStart : body.length;
    const end = el ? el.selectionEnd : body.length;
    const text = `{{${v}}}`;
    setBody(body.slice(0, at) + text + body.slice(end));
    requestAnimationFrame(() => {
      el?.focus();
      el?.setSelectionRange(at + text.length, at + text.length);
    });
  };

  const save = async () => {
    if (!canSave) return;
    setBusy(true);
    setError(null);
    try {
      await onSave({
        ...(command ?? {}),
        id: command?.id,
        name: name.trim(),
        description: description.trim() || undefined,
        body,
        target,
        submit: target === "type" ? submit : undefined,
        cwd: target !== "open" && cwd.trim() ? cwd.trim() : undefined,
        keys,
        confirm,
        workspace: workspace || undefined,
      });
    } catch (e) {
      setError(message(e));
      setBusy(false);
    }
  };

  saveRef.current = () => void save();
  const variables = [...Object.keys(QUICK_VARIABLES), ...Object.keys(ASKS)];
  const tips: Record<string, string> = { ...QUICK_VARIABLES, ...ASKS };
  return (
    <div ref={root}>
      <Stack gap={3}>
        {error && (
          <Callout tone="danger" title="Couldn't save it">
            {error}
          </Callout>
        )}
        <div>
          <FormSection>
            <FormRow title="Name">
              <TextField ref={nameRef} fill value={name} placeholder="Push Branch" onChange={setName} maxLength={80} />
            </FormRow>
            <FormRow title="Description">
              <TextField fill value={description} placeholder="Optional" onChange={setDescription} maxLength={200} />
            </FormRow>
            <FormRow
              stacked
              title="Command"
              description={target === "type" ? "A shell command, or a prompt for the agent in the terminal." : target === "open" ? "A URL or a path." : "A shell command."}
              note={problems.join(" · ") || undefined}
              noteTone="danger"
              accessory={
                <Select
                  value={"" as string}
                  placeholder="Insert Variable"
                  options={variables.map((v) => ({ value: v, label: `{{${v}}}`, tip: tips[v] }))}
                  onChange={(v) => insert(v)}
                  size="sm"
                  label="Insert Variable"
                />
              }
            >
              <TextArea ref={bodyRef} code value={body} placeholder="git push -u origin {{branch}}" onChange={setBody} onSubmit={() => void save()} rows={3} />
            </FormRow>
          </FormSection>
          <FormSection title="Running">
            <FormRow title="Where" description={TARGET_TEXT[target]}>
              <Segmented value={target} options={TARGETS} onChange={setTarget} />
            </FormRow>
            {target === "type" && (
              <FormRow title="Press Return" description="Off: it's typed for you to finish or edit.">
                <Switch checked={submit} onChange={setSubmit} label="Press Return" />
              </FormRow>
            )}
            {target !== "open" && (
              <FormRow title="Folder" description="Where a new terminal starts; the selected window's folder if empty.">
                <TextField fill code value={cwd} placeholder="{{folder}}" onChange={setCwd} />
              </FormRow>
            )}
            <FormRow title="Workspace" description={workspace ? "Only in this workspace’s menu and palette." : "In every workspace’s menu and palette."}>
              <Select
                value={workspace}
                options={[
                  { value: "", label: "Every Workspace" },
                  ...workspaces.map((w) => ({ value: w.root, label: w.name, tip: w.root })),
                  ...(workspace && !workspaces.some((w) => w.root === workspace) ? [{ value: workspace, label: workspace }] : []),
                ]}
                onChange={setWorkspace}
                label="Workspace"
              />
            </FormRow>
            <FormRow title="Shortcut" note={note ?? undefined} noteTone="danger">
              <ShortcutField
                keys={keys.map((k) => prettyAccelerator(k) ?? k)}
                recording={recording}
                onRecord={(i) => (setNote(null), setRecording(i))}
                onRemove={(i) => setKeys((ks) => ks.filter((_, j) => j !== i))}
              />
            </FormRow>
            <FormRow title="Ask before running" description="Shows what it will run, and runs it when you say so.">
              <Switch checked={confirm} onChange={setConfirm} label="Ask before running" />
            </FormRow>
          </FormSection>
          <FormActions
            hint={
              command && (
                <Button variant="ghost" onClick={() => void onDelete(command.id).catch((e: unknown) => setError(message(e)))}>
                  Delete
                </Button>
              )
            }
          >
            <Button onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={!canSave} busy={busy} data-tip="Save" data-tip-key="⌘↵" onClick={() => void save()}>
              Save
            </Button>
          </FormActions>
        </div>
      </Stack>
    </div>
  );
}
