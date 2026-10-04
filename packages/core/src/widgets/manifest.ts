// A widget's manifest.json (docs/14-magic-v2.md): what it is, how big it
// starts, how often its data runs, what its data.ts may touch, and the settings
// a person can change. The same file a widget store would publish.

export type WidgetSize = "s" | "m" | "l" | "wide";

export interface ConfigField {
  key: string;
  title: string;
  type: "string" | "number" | "boolean" | "enum";
  default?: string | number | boolean;
  options?: string[];
  /** Kept in cmd's secrets (never in the widget folder or the window state); reaches data.ts only. */
  secret?: boolean;
  description?: string;
}

export interface WidgetManifest {
  /** Manifest format. */
  cmd: 2;
  kind: "widget" | "terminal";
  title: string;
  description?: string;
  size: WidgetSize;
  /** Seconds between data runs; 0: only on Refresh Now. Ignored without data.ts. */
  refresh: number;
  /** Terminal kind: the command typed into a new terminal. */
  command?: string;
  permissions: {
    /** Hosts data.ts may reach ("api.example.com", "host:8080"); "*" for any. */
    net: string[];
    /** Programs data.ts may run with run() ("git", "gh"). */
    run: string[];
    /** Environment variables data.ts may read. */
    env: string[];
    /** Extra folders data.ts may read (its own folder always). "~" is home. */
    read: string[];
  };
  /** https origins the view plays audio/video or shows images from (asked once per window). */
  media: string[];
  config: ConfigField[];
}

/** Programs that would give data.ts everything: running them is never declared away. */
const ESCAPES = new Set(["sh", "bash", "zsh", "fish", "deno", "node", "python", "python3", "ruby", "perl", "osascript", "sudo", "env", "xargs", "open", "bun", "npx"]);

export const MIN_REFRESH = 2;

const strs = (v: unknown, max = 32): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string" && !!x.trim()).map((x) => x.trim()).slice(0, max) : []);

/** Validate a manifest (from a widget folder, so from the model): the manifest, or a list of problems. */
export function parseManifest(v: unknown): { ok: true; manifest: WidgetManifest } | { ok: false; errors: string[] } {
  const errors: string[] = [];
  if (!v || typeof v !== "object" || Array.isArray(v)) return { ok: false, errors: ["manifest.json must be a JSON object"] };
  const m = v as Record<string, unknown>;
  const kind = m.kind === "terminal" ? "terminal" : m.kind === "widget" || m.kind === undefined ? "widget" : null;
  if (!kind) errors.push('kind must be "widget" or "terminal"');
  const title = typeof m.title === "string" ? m.title.trim().slice(0, 120) : "";
  if (!title) errors.push("title is required");
  const size = m.size === "s" || m.size === "m" || m.size === "l" || m.size === "wide" ? m.size : "m";
  const refreshRaw = typeof m.refresh === "number" && Number.isFinite(m.refresh) && m.refresh >= 0 ? m.refresh : 0;
  const refresh = refreshRaw === 0 ? 0 : Math.max(MIN_REFRESH, Math.round(refreshRaw));
  const command = typeof m.command === "string" ? m.command.trim() : undefined;
  if (kind === "terminal" && !command) errors.push("a terminal widget needs command");
  const p = (m.permissions && typeof m.permissions === "object" ? m.permissions : {}) as Record<string, unknown>;
  const net = strs(p.net).map((h) => h.replace(/^https?:\/\//, "").replace(/\/.*$/, ""));
  for (const h of net) if (h !== "*" && !/^[a-z0-9.-]+(:\d+)?$/i.test(h)) errors.push(`permissions.net: "${h}" is not a host`);
  const run = strs(p.run);
  for (const r of run) {
    if (ESCAPES.has(r.split("/").pop()!)) errors.push(`permissions.run: "${r}" would let data.ts run anything; call the programs you need directly`);
    else if (!/^[\w./-]+$/.test(r)) errors.push(`permissions.run: "${r}" is not a program name`);
  }
  const env = strs(p.env);
  const read = strs(p.read);
  const media = strs(m.media, 12);
  for (const o of media) if (!/^https:\/\/[^/\s]+\/?$/.test(o)) errors.push(`media: "${o}" is not an https origin`);
  const config: ConfigField[] = [];
  for (const c of Array.isArray(m.config) ? m.config : []) {
    const f = c as Record<string, unknown>;
    if (!f || typeof f.key !== "string" || !/^[A-Za-z_][\w]*$/.test(f.key)) {
      errors.push(`config: each field needs a key (letters, digits, _)`);
      continue;
    }
    const type = f.type === "number" || f.type === "boolean" || f.type === "enum" ? f.type : "string";
    const field: ConfigField = { key: f.key, title: typeof f.title === "string" ? f.title : f.key, type };
    if (["string", "number", "boolean"].includes(typeof f.default)) field.default = f.default as string | number | boolean;
    if (type === "enum") field.options = strs(f.options);
    if (f.secret === true) field.secret = true;
    if (typeof f.description === "string") field.description = f.description;
    config.push(field);
  }
  if (errors.length) return { ok: false, errors };
  return {
    ok: true,
    manifest: {
      cmd: 2,
      kind: kind!,
      title,
      description: typeof m.description === "string" ? m.description : undefined,
      size,
      refresh,
      command,
      permissions: { net, run, env, read },
      media: media.map((o) => o.replace(/\/$/, "")),
      config,
    },
  };
}

/** Config values for a run: defaults, overridden by the window's values (secrets added by the caller). */
export function configValues(m: WidgetManifest, values: Record<string, unknown> = {}): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const f of m.config) {
    if (f.secret) continue;
    const v = values[f.key];
    out[f.key] = v !== undefined && v !== null && v !== "" ? v : f.default;
  }
  return out;
}
