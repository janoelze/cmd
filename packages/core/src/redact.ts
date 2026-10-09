// Credentials out of text before it is kept or shown to a model. One list for
// everything cmd records or sends: the activity log (raw hook payloads), the
// journal (commands, prompts, pages), summaries (transcripts), Magic (command
// output, files, fetched pages). Shapes with a known prefix are matched
// anywhere; otherwise a value counts when its name says it's a secret
// (KEY=value, "token": "value", --password value, user:pass@ in URLs) and the
// value isn't code ($VAR, process.env.X, <placeholder>, a type, a call).
//
// Checked against 1.9 GB of the author's transcripts (docs/25, 3.8): the
// first version matched on any name *containing* "auth" or "token", so most of
// what it removed was `author:`, `workflow-authoring`, `tokenize` and
// `maxOutputTokens`, while it missed `Bearer …`, `*_PASS="…"` and a bot token
// in a shell default. Hence: the secret word must end the name, separators are
// `:` or `=`, flags need their dash. Add a case to redact.test.ts for each new shape.
//
// Structured payloads (hook tool_input, transcript lines kept whole) hold the
// name as a key and the value as its own string, so redactDeep checks the key
// by the same rule: { password: "…" } and env maps go the way PASSWORD=… does.

/** Replaced whole. */
const TOKENS: RegExp[] = [
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
  /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*$/g, // cut off before its end (a clipped payload)
  /\bsk-(?:ant-(?:api\d\d-|oat\d\d-)?|proj-|live-|test-)?[A-Za-z0-9_-]{20,}/g, // Anthropic (API and OAuth), OpenAI
  /\b[sprk]k_(?:live|test)_[A-Za-z0-9]{16,}\b/g, // Stripe
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/g, // GitHub
  /\bgithub_pat_[A-Za-z0-9_]{30,}\b/g,
  /\bgl(?:pat|cbt|dt|ft|imt|oas|ptt|rt|soat)-[A-Za-z0-9_-]{20,}\b/g, // GitLab
  /\bxox[abeposr]-[A-Za-z0-9-]{10,}\b/g, // Slack
  /\bxapp-[A-Za-z0-9-]{10,}\b/g,
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, // AWS access key id
  /\bAIza[0-9A-Za-z_-]{35}\b/g, // Google API key
  /\bya29\.[A-Za-z0-9_-]{30,}/g, // Google OAuth
  /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\b/g, // SendGrid
  /\bnpm_[A-Za-z0-9]{30,}\b/g,
  /\bpypi-[A-Za-z0-9_-]{30,}\b/g,
  /\bhf_[A-Za-z0-9]{30,}\b/g, // Hugging Face
  /\b\d{8,10}:AA[A-Za-z0-9_-]{33}\b/g, // Telegram bot
  /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g, // JWT
];

/** Authorization headers: the scheme stays, the credential goes. */
const BEARER = /\bBearer\s+(?!\$|\[redacted\])[A-Za-z0-9._~+/=-]{16,}/g;
const BASIC = /\b(Authorization["']?\s*[:=]\s*["']?Basic\s+)[A-Za-z0-9+/]{16,}={0,2}/gi;
/** `Basic …` without its header name (a header map's value): only when it decodes to user:password, so "Basic internationalization" stays. */
const BASIC_VALUE = /\b(Basic\s+)([A-Za-z0-9+/]{16,}={0,2})(?![A-Za-z0-9+/=])/g;
const isUserPass = (b64: string) => /^[\x20-\x7e]+:[\x20-\x7e]*$/.test(Buffer.from(b64, "base64").toString("latin1"));

/** user:password@ in URLs: only the password goes. */
const URL_PASSWORD = /\b[a-z][a-z0-9+.-]*:\/\/[^\s:/@]+:(?!\$|\[redacted\])([^\s@/]{3,})@/gi;

/** `?token=…` and friends in URLs. */
const URL_PARAM = /([?&](?:token|access_token|api_key|apikey|secret|password|auth|sig|signature)=)(?!\$|\[redacted\])([^&\s"'<>]{8,})/gi;

/**
 * NAME=value, "name": "value", Name: value, where the name ends in a secret
 * word. Not a name inside a selector or a path (.ui-secret, --secret-edge, a.token).
 */
const SECRET_WORD = "(?:api[_-]?key|(?:secret|access|private|signing|encryption)[_-]?key|secret|token|passw(?:or)?d|pass|pwd|credentials?|authorization|cookie)";
const SECRET_KEY = new RegExp(`^(?:[A-Za-z_][A-Za-z0-9_-]*?)?${SECRET_WORD}$`, "i");
const NAMED = new RegExp(`(?<![\\w.#$-])((?:[A-Za-z_][A-Za-z0-9_-]*?)?${SECRET_WORD})(["']?[ \\t]*[:=][ \\t]*["']?)(?!\\[redacted\\]|:)([^\\s"'\`,;<>(){}\\[\\]]{8,})(?=$|[\\s"'\`,;<>){}\\]])`, "gi");
/** "pass" alone is a verb and a test result ("--- PASS: TestX"); it names a secret only as DB_PASS or PASS=. */
const BARE_PASS = /^pass$/i;
/** `key: password,` in an object literal: a plain word after an unquoted colon is a variable, not a value. */
const WORD_AFTER_COLON = (sep: string, value: string) => /^\s*:\s*$/.test(sep) && /^[A-Za-z]+$/.test(value);

/** --password x, --token=x: the flag's value goes. */
const FLAG = new RegExp(`((?<![\\w-])--?(?:password|passwd|pass|pwd|token|api-?key|secret)(?:=|\\s+))(?!\\$|<|-|\\[redacted\\])([^\\s"'\`]{4,})`, "gi");
/** A flag followed by a plain word is prose ("use --token only when…"), not a value. */
const WORD = /^[a-z]+$/;

/** Values that are code, not a secret: $VAR, ${VAR}, process.env.X, <placeholder>, a type, a dotted name. */
const PLACEHOLDER = /^(?:[$<{\-]|process\.env|os\.environ|env\.|string\b|number\b|boolean\b|null\b|undefined\b|true\b|false\b|function\b|async\b|await\b|return\b|typeof\b|require\b|import\b|new\b|Record\b|Promise\b|Array\b)|^[A-Za-z_][A-Za-z0-9_]*(?:\.[A-Za-z_][A-Za-z0-9_]*)+$|^\[redacted\]/;

/** `text` with likely credentials replaced by [redacted]. */
export function redact(text: string): string {
  if (!text || text.length < 8) return text;
  let r = text;
  for (const p of TOKENS) r = r.replace(p, "[redacted]");
  r = r.replace(BEARER, "Bearer [redacted]");
  r = r.replace(BASIC, "$1[redacted]");
  r = r.replace(BASIC_VALUE, (m, scheme: string, b64: string) => (isUserPass(b64) ? `${scheme}[redacted]` : m));
  r = r.replace(URL_PASSWORD, (m, pw: string) => m.slice(0, m.length - pw.length - 1) + "[redacted]@");
  r = r.replace(URL_PARAM, "$1[redacted]");
  r = r.replace(FLAG, (m, flag: string, value: string) => (PLACEHOLDER.test(value) || WORD.test(value) ? m : `${flag}[redacted]`));
  return r.replace(NAMED, (m, name: string, sep: string, value: string) => (PLACEHOLDER.test(value) || (BARE_PASS.test(name) && !(name === "PASS" && sep.includes("="))) || WORD_AFTER_COLON(sep, value) ? m : `${name}${sep}[redacted]`));
}

/** Whether a key names a secret: the secret word ends it, as in NAMED (`author`, `tokenize`, `maxOutputTokens` don't). */
export function secretKey(key: string): boolean {
  return SECRET_KEY.test(key) && !BARE_PASS.test(key);
}

/** An Authorization value's scheme, kept as BEARER and BASIC keep it in text. */
const SCHEME = /^(?:Basic|Bearer|Token|Digest)\s+/i;

/** Every string inside a JSON value, redacted; structure kept. A string under a key that names a secret goes whole (an array's items count as under its key). */
export function redactDeep<T>(v: T, key?: string): T {
  if (typeof v === "string") return (key && v.length >= 8 && secretKey(key) && !PLACEHOLDER.test(v) ? `${SCHEME.exec(v)?.[0] ?? ""}[redacted]` : redact(v)) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x, key)) as T;
  if (v && typeof v === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, x] of Object.entries(v as Record<string, unknown>)) out[k] = redactDeep(x, k);
    return out as T;
  }
  return v;
}

/** An event's text, body, payload and content, redacted (what the log stores). */
export function redactEvent<E extends { text?: string | null; body?: string | null; data?: unknown; content?: string | Buffer | null }>(e: E): E {
  return { ...e, text: e.text ? redact(e.text) : e.text, body: e.body ? redact(e.body) : e.body, data: redactDeep(e.data), content: typeof e.content === "string" ? redact(e.content) : e.content };
}
