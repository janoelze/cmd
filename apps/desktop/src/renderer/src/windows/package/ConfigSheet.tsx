// A package widget's Configure sheet (docs/56, "Configuring a package widget"): a row per
// config field of its package.json (title, description, the control its type asks for, the
// default as placeholder), and its secret fields as Set / Not set with Change and Remove,
// each saying the one host it is sent to. Nothing is sent until Save: the values go to the
// window (widget.config; the process gets them and redraws), each changed secret to cmd's
// secrets (widget.secret). A secret is typed here once and never shown again: the sheet only
// knows whether one is set (widget.secrets). Opened from the window's title menu and context
// menu (register.tsx) and from its "Set up" cover (PackageView.tsx), as a sheet over the board.
// The rows are the package's own, not MagicEditor's: Magic's commit each change at once.

import { Badge, Button, Callout, Dialog, FormSection, FormRow, Inline, Presence, Select, Switch, TextField } from "@cmd/ui";
import { useEffect, useState, type ReactNode } from "react";
import { parsePackageKind, type WidgetConfigField, type WidgetEntry, type WindowId } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { useStoreValue } from "../../lib/store.ts";
import { closeSheet, openSheet, useSheet } from "../../shell/sheets.ts";

/** Where the sheet's answers go: the core (rpcConfig), or a fake in stories and tests. */
export interface ConfigApi {
  config(values: Record<string, unknown>): Promise<unknown>;
  secret(key: string, value: string | null): Promise<unknown>;
  /** Which secret fields are set. */
  secrets(): Promise<string[]>;
}

export function rpcConfig(windowId: WindowId, name: string, widget: string): ConfigApi {
  return {
    config: (values) => cmd.call("widget.config", { windowId, values }),
    secret: (key, value) => cmd.call("widget.secret", { name, widget, key, value }),
    secrets: () => cmd.call("widget.secrets", { name, widget }).then((r) => r.set),
  };
}

/** Open the Configure sheet of a package widget's window. */
export const configure = (windowId: WindowId) => openSheet({ kind: "widgetConfig", windowId });

/** The Library entry of a package widget's window, when it has config fields. */
export const configurable = (entry: WidgetEntry | undefined): entry is WidgetEntry & { config: WidgetConfigField[] } => !!entry?.config?.length;

const isSet = (v: unknown) => v !== undefined && v !== null && v !== "";

/**
 * Whether the window shows "Set up" instead of its tree: it has config fields, none is set yet
 * (no value, no secret), and one it needs is missing (a secret, or a field without a default).
 */
export function needsSetup(entry: WidgetEntry | undefined, config: Record<string, unknown> | undefined): boolean {
  if (!configurable(entry)) return false;
  const secrets = entry.secrets ?? [];
  if (entry.config.some((f) => (f.secret ? secrets.includes(f.key) : isSet(config?.[f.key])))) return false;
  return entry.config.some((f) => f.secret || !isSet(f.default));
}

/** The sheet for the window the sheets say (shell/sheets.ts), over the board. */
export function ConfigSheets() {
  const sheet = useSheet();
  const id = sheet?.kind === "widgetConfig" ? sheet.windowId : null;
  const win = useStoreValue((s) => (id ? s.windows.get(id) : undefined));
  const entry = useStoreValue((s) => (win ? s.library.find((e) => e.kind === win.kind) : undefined));
  const target = win && configurable(entry) ? { win, entry } : null;
  return (
    <Presence when={target}>
      {({ win, entry }, open) => {
        const kind = parsePackageKind(win.kind)!;
        return <ConfigSheet key={win.id} entry={entry} config={win.state.config as Record<string, unknown> | undefined} open={open} onClose={closeSheet} api={rpcConfig(win.id, kind.name, kind.widget)} />;
      }}
    </Presence>
  );
}

const message = (e: unknown) => (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function ConfigSheet({ entry, config, open = true, onClose, api }: { entry: WidgetEntry & { config: WidgetConfigField[] }; config: Record<string, unknown> | undefined; open?: boolean; onClose: () => void; api: ConfigApi }) {
  const [values, setValues] = useState<Record<string, unknown>>(() => ({ ...config }));
  // Secrets typed (a string) or removed (null) here; not in it: as they are.
  const [secrets, setSecrets] = useState<Record<string, string | null>>({});
  const [set, setSet] = useState<string[]>(entry.secrets ?? []);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const hasSecrets = entry.config.some((f) => f.secret);
  // Asked once as it opens (the Library's entry may be a moment behind).
  const [ask] = useState(() => api.secrets);
  useEffect(() => {
    if (!hasSecrets) return;
    let alive = true;
    ask().then((s) => alive && setSet(s), () => {});
    return () => void (alive = false);
  }, [ask, hasSecrets]);

  const save = async () => {
    if (busy) return;
    const changed: Record<string, unknown> = {};
    for (const f of entry.config) {
      if (f.secret) continue;
      const typed = values[f.key];
      // A number as a number when it is one; else as typed, for the core to say what's wrong.
      const v = f.type === "number" && typeof typed === "string" && typed.trim() && Number.isFinite(Number(typed)) ? Number(typed) : typed;
      if ((isSet(v) ? v : null) !== (isSet(config?.[f.key]) ? config![f.key] : null)) changed[f.key] = isSet(v) ? v : null;
    }
    setBusy(true);
    setError(null);
    try {
      if (Object.keys(changed).length) await api.config(changed);
      for (const [key, v] of Object.entries(secrets)) if (v === null || v.trim()) await api.secret(key, v === null ? null : v.trim());
      onClose();
    } catch (e) {
      setError(message(e));
    }
    setBusy(false);
  };

  const plain = entry.config.filter((f) => !f.secret);
  const secret = entry.config.filter((f) => f.secret);
  return (
    <Dialog
      open={open}
      onClose={onClose}
      dismissable={!busy}
      window={{ icon: entry.icon, name: entry.title }}
      label={`Configure ${entry.title}`}
      title={`Configure ${entry.title}`}
      width={520}
      position="center"
      actions={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" busy={busy} onClick={() => void save()}>
            Save
          </Button>
        </>
      }
    >
      {error && (
        <Callout tone="danger" title="Couldn't save these settings">
          {error}
        </Callout>
      )}
      {plain.length > 0 && (
        <FormSection title="Settings">
          {plain.map((f) => (
            <FormRow key={f.key} title={f.title} tip={f.key} description={f.description}>
              <FieldControl field={f} value={values[f.key]} onChange={(v) => setValues((cur) => ({ ...cur, [f.key]: v }))} onEnter={() => void save()} />
            </FormRow>
          ))}
        </FormSection>
      )}
      {secret.length > 0 && (
        <FormSection title="Secrets">
          {secret.map((f) => (
            <FormRow key={f.key} title={f.title} tip={f.key} description={f.description} note={f.host ? `Sent only to ${f.host}` : undefined} noteTone="dim">
              <SecretControl
                field={f}
                stored={set.includes(f.key)}
                staged={secrets[f.key]}
                onStage={(v) => setSecrets((cur) => (v === undefined ? Object.fromEntries(Object.entries(cur).filter(([k]) => k !== f.key)) : { ...cur, [f.key]: v }))}
                onEnter={() => void save()}
              />
            </FormRow>
          ))}
        </FormSection>
      )}
    </Dialog>
  );
}

/** The control a field's type asks for; text and numbers show the default as their placeholder. */
function FieldControl({ field, value, onChange, onEnter }: { field: WidgetConfigField; value: unknown; onChange: (v: unknown) => void; onEnter: () => void }) {
  const shown = isSet(value) ? value : field.default;
  if (field.type === "boolean") return <Switch checked={!!shown} onChange={onChange} label={field.title} />;
  if (field.type === "enum") {
    const options = field.options ?? [];
    return <Select value={isSet(shown) ? String(shown) : ""} options={options} placeholder="Choose…" onChange={onChange} />;
  }
  const number = field.type === "number";
  const invalid = number && isSet(value) && !Number.isFinite(Number(value));
  return (
    <TextField
      width={240}
      value={isSet(value) ? String(value) : ""}
      inputMode={number ? "decimal" : undefined}
      invalid={invalid}
      placeholder={isSet(field.default) ? String(field.default) : ""}
      onChange={onChange}
      onKeyDown={(e) => e.key === "Enter" && onEnter()}
    />
  );
}

/**
 * A secret: Set (with Change and Remove) or Not set (a field to type it in). Never its value:
 * the field is a password field, and a stored one shows only that it is set.
 */
function SecretControl({ field, stored, staged, onStage, onEnter }: { field: WidgetConfigField; stored: boolean; staged: string | null | undefined; onStage: (v: string | null | undefined) => void; onEnter: () => void }) {
  const [changing, setChanging] = useState(false);
  let body: ReactNode;
  if (staged === null)
    body = (
      <>
        <Badge>Removed when you save</Badge>
        <Button size="sm" onClick={() => onStage(undefined)}>
          Undo
        </Button>
      </>
    );
  else if (stored && !changing && staged === undefined)
    body = (
      <>
        <Badge tone="success">Set</Badge>
        <Button size="sm" onClick={() => setChanging(true)}>
          Change
        </Button>
        <Button size="sm" onClick={() => onStage(null)}>
          Remove
        </Button>
      </>
    );
  else
    body = (
      <>
        <TextField
          code
          type="password"
          autoComplete="off"
          width={240}
          autoFocus={changing}
          aria-label={field.title}
          value={staged ?? ""}
          placeholder={stored ? "New value" : "Not set"}
          onChange={(v) => onStage(v)}
          onKeyDown={(e) => e.key === "Enter" && onEnter()}
        />
        {changing && (
          <Button size="sm" onClick={() => (setChanging(false), onStage(undefined))}>
            Cancel
          </Button>
        )}
      </>
    );
  return (
    <Inline gap={1.5}>{body}</Inline>
  );
}
