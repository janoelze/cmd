// Quick Commands' file (docs/58-quick-commands.md): quick-commands.json beside settings.json,
// read, watched and written here. A save changes one item in the text (editJsoncItem), so the
// person's comments and order survive; a file that doesn't parse keeps its last good commands
// and says why, and isn't written over until it is fixed.

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";
import { editJsoncItem, parseJsonc, QUICK_TARGETS, quickId, readQuickCommands, RpcError, type QuickCommand, type QuickList } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";

const log = logger("quick");

const HEADER = `// cmd Quick Commands (docs/58). Edit them in Settings → Quick Commands, or here; changes apply live.
// { "name": "Push Branch", "body": "git push -u origin {{branch}}", "target": "type", "keys": ["Ctrl+Alt+P"] }
// target: "type" (into the selected terminal, else a new one), "terminal" (a new one), "open" (a URL or path).
// Variables: {{folder}} {{workspace}} {{file}} {{selection}} {{clipboard}} {{branch}} {{repo}} {{url}} {{date}} {{time}},
// {{ask:name=default}} and {{pick:name=a,b}} ask when it runs; values are quoted for the shell ({{selection | raw}}: as is).
// "workspace": "~/src/app" keeps one to that workspace (its folder); without it, it is in every workspace.
[
]
`;

/** The keys a command is written with, in this order; the rest (a newer cmd's) after them. */
const ORDER = ["id", "name", "description", "body", "target", "submit", "cwd", "keys", "confirm", "workspace"] as const;

export class QuickService extends EventEmitter<{ changed: [] }> {
  readonly path: string;
  /** The file's text; the store itself when there is no file (tests). */
  #text = "";
  #list: QuickList;
  #watcher: fs.FSWatcher | null = null;
  #debounce: NodeJS.Timeout | undefined;

  /** file = null keeps them in memory only (tests). */
  constructor(file: string | null) {
    super();
    this.path = file ?? "";
    this.#list = { commands: [], path: this.path };
    this.#load();
  }

  list(): QuickList {
    return this.#list;
  }

  get(idOrName: string): QuickCommand | undefined {
    const all = this.#list.commands;
    return all.find((c) => c.id === idOrName) ?? all.find((c) => c.name === idOrName) ?? all.find((c) => c.name.toLowerCase() === idOrName.toLowerCase());
  }

  /** Add one (no id: made from its name) or replace the one with its id; `before` places a new one. */
  save(c: Omit<QuickCommand, "id"> & { id?: string }, before?: string): QuickCommand {
    const all = this.#writable();
    if (!c.name?.trim()) throw RpcError.of("invalidParams", "A Quick Command needs a name");
    if (typeof c.body !== "string") throw RpcError.of("invalidParams", "A Quick Command needs a body");
    if (c.target && !QUICK_TARGETS.includes(c.target)) throw RpcError.of("invalidParams", `target is one of ${QUICK_TARGETS.join(", ")}`);
    const at = c.id ? all.findIndex((x) => x.id === c.id) : -1;
    const command = tidy({ ...c, name: c.name.trim(), id: c.id ?? quickId(c.name, all.map((x) => x.id)) } as QuickCommand);
    if (at >= 0) this.#write(editJsoncItem(this.#text, at, command));
    else {
      const b = before ? all.findIndex((x) => x.id === before) : -1;
      this.#write(editJsoncItem(this.#text, b, command, { insert: true, base: HEADER }));
    }
    return command;
  }

  remove(id: string): void {
    const at = this.#writable().findIndex((x) => x.id === id);
    if (at < 0) throw RpcError.of("notFound", `no Quick Command ${id}`);
    this.#write(editJsoncItem(this.#text, at, undefined));
  }

  /** Move one before another (null: to the end). */
  move(id: string, before: string | null): void {
    const all = this.#writable();
    const at = all.findIndex((x) => x.id === id);
    if (at < 0) throw RpcError.of("notFound", `no Quick Command ${id}`);
    if (before === id) return;
    // The item as written in the file (unknown keys and all), not as read.
    const item = (parseJsonc(this.#text) as unknown[])[at];
    let text = editJsoncItem(this.#text, at, undefined);
    const rest = all.filter((x) => x.id !== id);
    const b = before ? rest.findIndex((x) => x.id === before) : -1;
    text = editJsoncItem(text, b, item, { insert: true, base: HEADER });
    this.#write(text);
  }

  /** Watch the folder, not the file: editors often replace the file on save. */
  watch(): void {
    if (!this.path || this.#watcher) return;
    const name = path.basename(this.path);
    try {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      this.#watcher = fs.watch(path.dirname(this.path), (_e, f) => {
        if (f !== name) return;
        clearTimeout(this.#debounce);
        this.#debounce = setTimeout(() => this.#reload(), 100);
      });
      this.#watcher.unref();
      // A watch can fail later (EMFILE); the poll below carries on.
      this.#watcher.on("error", (err) => {
        log.warn("watch failed; polling only", err);
        this.#watcher?.close();
        this.#watcher = null;
      });
    } catch (err) {
      log.warn("can't watch", err);
    }
    // FSEvents can miss changes (right after the watch starts); poll as a backstop.
    fs.watchFile(this.path, { interval: 1000, persistent: false }, () => this.#reload());
  }

  dispose(): void {
    clearTimeout(this.#debounce);
    this.#watcher?.close();
    this.#watcher = null;
    if (this.path) fs.unwatchFile(this.path);
  }

  /** The commands, when the file can be written: one that doesn't parse is the person's to fix first. */
  #writable(): QuickCommand[] {
    if (this.#list.error) throw RpcError.of("failed", `${path.basename(this.path) || "quick-commands.json"} can't be read (${this.#list.error}): fix it first`);
    return this.#list.commands;
  }

  #write(text: string): void {
    if (this.path) {
      fs.mkdirSync(path.dirname(this.path), { recursive: true });
      const tmp = `${this.path}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, text);
      fs.renameSync(tmp, this.path);
    }
    this.#text = text;
    this.#reload();
  }

  #reload(): void {
    const before = JSON.stringify(this.#list);
    this.#load();
    if (JSON.stringify(this.#list) !== before) this.emit("changed");
  }

  #load(): void {
    if (this.path) {
      try {
        this.#text = fs.readFileSync(this.path, "utf8");
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== "ENOENT") {
          this.#list = { ...this.#list, error: (err as Error).message };
          return;
        }
        this.#text = "";
      }
    }
    if (!this.#text.trim()) {
      this.#list = { commands: [], path: this.path };
      return;
    }
    try {
      const r = readQuickCommands(parseJsonc(this.#text) ?? []);
      // A workspace written with ~ is compared as the folder it is.
      const commands = r.commands.map((c) => (c.workspace?.startsWith("~") ? { ...c, workspace: c.workspace.replace(/^~(?=$|\/)/, os.homedir()) } : c));
      // Entries that aren't commands are left out and said so; the file stays writable (they stay in it).
      this.#list = { commands, path: this.path, ...(r.errors.length ? { problems: r.errors } : {}) };
      if (r.errors.length) log.warn("left out", { problems: r.errors });
    } catch (err) {
      this.#list = { commands: this.#list.commands, path: this.path, error: (err as Error).message };
    }
  }
}

/** Its keys in ORDER, defaults and empties left out (submit: true, an empty description). */
function tidy(c: QuickCommand): QuickCommand {
  const out: Record<string, unknown> = {};
  const src = c as unknown as Record<string, unknown>;
  for (const k of ORDER) {
    const v = src[k];
    if (v === undefined || v === "" || (k === "submit" && v === true) || (k === "confirm" && v === false) || (k === "keys" && Array.isArray(v) && !v.length)) continue;
    out[k] = v;
  }
  for (const [k, v] of Object.entries(src)) if (!(ORDER as readonly string[]).includes(k) && v !== undefined) out[k] = v;
  return out as unknown as QuickCommand;
}
