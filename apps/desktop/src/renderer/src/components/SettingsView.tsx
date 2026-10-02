// Generated from SETTINGS_SCHEMA: every key gets a control, nothing is hand-wired.

import { useEffect, useState } from "react";
import { SETTINGS_SCHEMA, type SettingDef, type SettingKey } from "@cmd/protocol";
import { COMMANDS, DEFAULT_KEYBINDINGS, prettyAccelerator } from "../../../shared/commands.ts";
import { useKeybindings } from "../keybindings.ts";
import { cmd } from "../bridge.ts";
import { useStore } from "../store.ts";

const GROUPS: Record<string, string> = {
  terminal: "Terminal",
  shell: "Shell",
  ui: "Interface",
  notifications: "Notifications",
  agents: "Agents",
};

export function SettingsView({ onClose }: { onClose: () => void }) {
  const { settings: snap } = useStore();
  const keys = useKeybindings();
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const save = async (key: SettingKey, value: unknown) => {
    try {
      setError(null);
      await cmd.call("settings.set", { key, value });
    } catch (err) {
      setError((err as Error).message);
    }
  };

  const groups = new Map<string, SettingKey[]>();
  for (const key of Object.keys(SETTINGS_SCHEMA) as SettingKey[]) {
    const g = key.split(".")[0]!;
    groups.set(g, [...(groups.get(g) ?? []), key]);
  }

  return (
    <div className="palette-backdrop" onMouseDown={onClose}>
      <div className="settings" onMouseDown={(e) => e.stopPropagation()}>
        <header className="settings-head">
          <span className="settings-title">Settings</span>
          <button className="btn" onClick={() => cmd.openSettingsFile(snap.path)} disabled={!snap.path}>
            Open settings.json
          </button>
        </header>
        {[...snap.errors, ...keys.errors, ...(error ? [error] : [])].map((e) => (
          <div key={e} className="settings-error">
            {e}
          </div>
        ))}
        <div className="settings-body">
          {[...groups].map(([g, keys]) => (
            <section key={g}>
              <h3 className="list-heading">{GROUPS[g] ?? g}</h3>
              {keys.map((key) => (
                <Field
                  key={key}
                  k={key}
                  def={SETTINGS_SCHEMA[key]}
                  value={snap.settings[key]}
                  overridden={snap.overrides.includes(key)}
                  onSave={(v) => save(key, v)}
                  onReset={() => void cmd.call("settings.reset", { key })}
                />
              ))}
            </section>
          ))}
          <section>
            <h3 className="list-heading shortcuts-heading">
              Keyboard Shortcuts
              <button className="btn" onClick={() => cmd.openKeybindingsFile()}>
                Edit keybindings.json
              </button>
            </h3>
            {COMMANDS.map((c) => {
              const bound = keys.bindings[c.id] ?? [];
              const changed = JSON.stringify(bound) !== JSON.stringify(DEFAULT_KEYBINDINGS[c.id] ?? []);
              return (
                <div className="field shortcut" key={c.id}>
                  <div className="field-text">
                    <div className="field-key">{c.label.replace(/…$/, "")}{changed && <span className="field-changed">customized</span>}</div>
                    <div className="field-desc">{c.id}</div>
                  </div>
                  <div className="field-control keys">
                    {bound.length ? bound.map((k) => <kbd key={k}>{prettyAccelerator(k)}</kbd>) : <span className="field-desc">—</span>}
                  </div>
                </div>
              );
            })}
          </section>
        </div>
        <footer className="palette-foot">
          <span>Saved to {snap.path.replace(/^\/Users\/[^/]+/, "~")} · applies live</span>
        </footer>
      </div>
    </div>
  );
}

function Field(p: {
  k: SettingKey;
  def: SettingDef;
  value: unknown;
  overridden: boolean;
  onSave: (v: unknown) => void;
  onReset: () => void;
}) {
  const { def } = p;
  // Text and number inputs commit on blur/Enter, not on every keystroke.
  const [draft, setDraft] = useState(String(p.value));
  useEffect(() => setDraft(String(p.value)), [p.value]);
  const commit = () => {
    if (draft === String(p.value)) return;
    p.onSave(def.type === "number" ? Number(draft) : draft);
  };

  let control;
  if (def.type === "boolean") {
    control = (
      <input type="checkbox" className="switch" checked={p.value as boolean} onChange={(e) => p.onSave(e.target.checked)} />
    );
  } else if (def.type === "enum") {
    control = (
      <select value={p.value as string} onChange={(e) => p.onSave(e.target.value)}>
        {def.options.map((o) => (
          <option key={o}>{o}</option>
        ))}
      </select>
    );
  } else {
    control = (
      <input
        type={def.type === "number" ? "number" : "text"}
        value={draft}
        min={def.type === "number" ? def.min : undefined}
        max={def.type === "number" ? def.max : undefined}
        step={def.type === "number" ? (def.step ?? 1) : undefined}
        placeholder={def.type === "string" && !def.default ? "(default)" : undefined}
        onChange={(e) => setDraft(e.target.value)}
        onBlur={commit}
        onKeyDown={(e) => e.key === "Enter" && commit()}
        spellCheck={false}
      />
    );
  }

  return (
    <div className="field">
      <div className="field-text">
        <div className="field-key">
          {p.k.split(".").slice(1).join(".")}
          {p.overridden && (
            <button className="field-reset" onClick={p.onReset} title="Reset to default">
              reset
            </button>
          )}
        </div>
        <div className="field-desc">{def.description}</div>
      </div>
      <div className="field-control">{control}</div>
    </div>
  );
}
