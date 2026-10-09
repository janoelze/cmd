// ~/.config/cmd/keybindings.json: user remaps of command shortcuts, watched live.

import fs from "node:fs";
import path from "node:path";
import { editJsonc, parseJsoncObject } from "@cmd/protocol";
import { configDir } from "@cmd/protocol/node";
import { editKeybindings, resolveKeybindings, type Keybindings } from "../shared/commands.ts";

export interface KeybindingsSnapshot {
  bindings: Keybindings;
  errors: string[];
  path: string;
}

export const keybindingsPath = () => path.join(configDir(), "keybindings.json");

const HEADER = `// cmd keybindings. Map a command id to a shortcut, a list of shortcuts, or null
// to unbind. Shortcuts use Electron accelerator syntax: "Alt+Cmd+Right", "Ctrl+Tab".
// Command ids are listed under Settings → Keyboard Shortcuts. Changes apply live.
`;

export const KEYBINDINGS_TEMPLATE = `${HEADER}{
  // "session.next": ["Alt+Cmd+Right", "Ctrl+Tab"],
}
`;

export function loadKeybindings(): KeybindingsSnapshot {
  const file = keybindingsPath();
  let user: unknown = {};
  const errors: string[] = [];
  try {
    user = parseJsoncObject(fs.readFileSync(file, "utf8"));
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") errors.push(`keybindings.json: ${(err as Error).message}`);
  }
  const r = resolveKeybindings(user);
  return { bindings: r.bindings, errors: [...errors, ...r.errors.map((e) => `keybindings.json: ${e}`)], path: file };
}

export function watchKeybindings(onChange: (s: KeybindingsSnapshot) => void): void {
  const file = keybindingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  let t: NodeJS.Timeout | undefined;
  fs.watch(path.dirname(file), (_e, name) => {
    if (name && name !== path.basename(file)) return;
    clearTimeout(t);
    t = setTimeout(() => onChange(loadKeybindings()), 100);
  }).unref();
}

export function ensureKeybindingsFile(): string {
  const file = keybindingsPath();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, KEYBINDINGS_TEMPLATE);
  }
  return file;
}

/**
 * Bind `keys` to command `id` (null: its defaults) from the Settings window.
 * Changes only the keys that differ, in the text, so comments survive; the
 * watcher then applies it. A file that doesn't parse is left alone.
 */
export function writeKeybinding(id: string, keys: string[] | null): void {
  const file = keybindingsPath();
  let text = "";
  let user: Record<string, unknown>;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw new Error(`Couldn't read keybindings.json: ${(err as Error).message}`);
  }
  try {
    user = parseJsoncObject(text);
  } catch (err) {
    throw new Error(`keybindings.json: ${(err as Error).message}. Fix it first.`);
  }
  const next = editKeybindings(user, id, keys);
  const changes: Record<string, unknown> = {};
  for (const k of Object.keys(user)) if (!(k in next)) changes[k] = undefined;
  for (const [k, v] of Object.entries(next)) if (JSON.stringify(v) !== JSON.stringify(user[k])) changes[k] = v;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, editJsonc(text, changes, KEYBINDINGS_TEMPLATE));
  fs.renameSync(tmp, file);
}

/** Settings → Keyboard Shortcuts → Restore Defaults: the file back to its template. */
export function resetKeybindings(): void {
  const file = keybindingsPath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(`${file}.tmp`, KEYBINDINGS_TEMPLATE);
  fs.renameSync(`${file}.tmp`, file);
}
