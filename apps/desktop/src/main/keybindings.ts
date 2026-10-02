// ~/.config/cmd/keybindings.json: user remaps of command shortcuts, watched live.

import fs from "node:fs";
import path from "node:path";
import { parseJsonc } from "@cmd/protocol";
import { configDir } from "@cmd/protocol/node";
import { resolveKeybindings, type Keybindings } from "../shared/commands.ts";

export interface KeybindingsSnapshot {
  bindings: Keybindings;
  errors: string[];
  path: string;
}

export const keybindingsPath = () => path.join(configDir(), "keybindings.json");

export const KEYBINDINGS_TEMPLATE = `// cmd keybindings. Map a command id to a shortcut, a list of shortcuts, or null
// to unbind. Shortcuts use Electron accelerator syntax: "Alt+Cmd+Right", "Ctrl+Tab".
// Command ids are listed under Settings → Keyboard Shortcuts. Changes apply live.
{
  // "session.next": ["Alt+Cmd+Right", "Ctrl+Tab"],
}
`;

export function loadKeybindings(): KeybindingsSnapshot {
  const file = keybindingsPath();
  let user: unknown = {};
  const errors: string[] = [];
  try {
    user = parseJsonc(fs.readFileSync(file, "utf8"));
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
