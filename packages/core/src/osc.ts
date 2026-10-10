// Incremental scanner for OSC sequences in PTY output, for bells (BEL outside
// any escape string) and for device attribute queries (CSI c, CSI > c), which
// the core answers so programs that wait for them (fish, Neovim) start without
// a window showing the terminal. Sequences may be split across chunks, so state
// is carried between calls; kitty's OSC 99 notifications may also span sequences.
// Where a string ends follows xterm.js: CAN and SUB abort any sequence, the 8-bit
// C1 forms stand for their 7-bit ones, and an OSC over MAX_OSC is skipped to its end.

import type { Progress } from "@cmd/protocol";

export type OscEvent =
  | { type: "title"; title: string } // OSC 0 / 2
  | { type: "cwd"; cwd: string } // OSC 7 file://host/path
  | { type: "notify"; title: string; body: string } // OSC 9 / OSC 777;notify / OSC 99
  | { type: "prompt"; mark: string; exitCode?: number } // OSC 133 shell integration (A/B/C/D;exit)
  | { type: "bell" } // BEL outside escape strings
  | { type: "query"; query: "da1" | "da2" } // CSI c / CSI > c
  | { type: "progress"; progress: Progress | null } // OSC 9;4;state;value (ConEmu, Windows Terminal, Ghostty)
  | { type: "request"; token: string; action: string; arg: string }; // OSC 777;cmd;<token>;<action>;<arg>

const ESC = "\x1b";
const BEL = "\x07";
const CAN = "\x18";
const SUB = "\x1a";
const MAX_OSC = 8192;
/** The 8-bit C1 controls (U+0090…U+009F) that open or end strings, as the char after ESC. */
const C1: Record<number, string> = { 0x90: "P", 0x98: "X", 0x9b: "[", 0x9c: "\\", 0x9d: "]", 0x9e: "^", 0x9f: "_" };

export class OscScanner {
  #inOsc = false;
  /** The OSC passed MAX_OSC (an inline image, a long OSC 52): dropped up to its terminator. */
  #skipOsc = false;
  /** Inside a CSI sequence (ESC [): its parameter and intermediate bytes so far. */
  #csi: string | null = null;
  /** Inside a DCS/APC/PM/SOS string (ESC P, _, ^, X … ST): BELs there aren't bells. */
  #inString = false;
  #pendingEsc = false;
  #buf = "";
  /** OSC 99 notifications being assembled, by id (d=0 means more chunks follow). */
  #kitty = new Map<string, { title: string; body: string }>();

  feed(chunk: string): OscEvent[] {
    const out: OscEvent[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      const c = ch.charCodeAt(0);
      const seven = c >= 0x90 && c <= 0x9f ? C1[c] : undefined;
      if (seven) {
        this.#step(ESC, out);
        this.#step(seven, out);
      } else this.#step(ch, out);
    }
    return out;
  }

  /** One char, C1 forms already turned into ESC and their 7-bit char. */
  #step(ch: string, out: OscEvent[]): void {
    if (ch === CAN || ch === SUB) {
      this.#inOsc = this.#skipOsc = this.#inString = this.#pendingEsc = false;
      this.#csi = null;
      this.#buf = "";
      return;
    }
    if (this.#inString) {
      if (this.#pendingEsc) {
        this.#pendingEsc = false;
        if (ch === "\\") this.#inString = false;
      }
      if (ch === ESC) this.#pendingEsc = true;
      return;
    }
    if (this.#csi !== null) {
      const c = ch.charCodeAt(0);
      if (c >= 0x40 && c <= 0x7e) {
        const ev = ch === "c" ? deviceQuery(this.#csi) : null;
        if (ev) out.push(ev);
        this.#csi = null;
      } else if (ch === ESC) {
        this.#csi = null;
        this.#pendingEsc = true;
      } else if (c >= 0x20 && this.#csi.length < 32) this.#csi += ch;
      else if (c >= 0x20) this.#csi = null;
      return;
    }
    if (!this.#inOsc) {
      if (this.#pendingEsc) {
        this.#pendingEsc = false;
        if (ch === "[") {
          this.#csi = "";
          return;
        }
        if (ch === "]") {
          this.#inOsc = true;
          this.#buf = "";
          return;
        }
        if (ch === "P" || ch === "_" || ch === "^" || ch === "X") {
          this.#inString = true;
          return;
        }
      }
      if (ch === ESC) this.#pendingEsc = true;
      else if (ch === BEL) out.push({ type: "bell" });
      return;
    }
    // inside OSC: terminated by BEL or ST (ESC \)
    if (this.#pendingEsc) {
      this.#pendingEsc = false;
      if (ch === "\\") {
        this.#finish(out);
        return;
      }
      if (!this.#skipOsc) this.#buf += ESC;
    }
    if (ch === BEL) {
      this.#finish(out);
    } else if (ch === ESC) {
      this.#pendingEsc = true;
    } else if (!this.#skipOsc) {
      this.#buf += ch;
      if (this.#buf.length > MAX_OSC) {
        this.#skipOsc = true;
        this.#buf = "";
      }
    }
  }

  #finish(out: OscEvent[]): void {
    this.#inOsc = false;
    if (this.#skipOsc) {
      this.#skipOsc = false;
      this.#buf = "";
      return;
    }
    const ev = this.#buf.startsWith("99;") ? this.#kittyNotify(this.#buf.slice(3)) : parseOsc(this.#buf);
    this.#buf = "";
    if (ev) out.push(ev);
  }

  /**
   * kitty's notification protocol: `99;key=value:…;payload`. p= says whether the
   * payload is the title (default) or the body, e=1 that it's base64, d=0 that more
   * chunks with the same i= follow. Queries and other payload types are ignored.
   */
  #kittyNotify(rest: string): OscEvent | null {
    const semi = rest.indexOf(";");
    const meta = new Map((semi < 0 ? rest : rest.slice(0, semi)).split(":").map((kv) => kv.split("=", 2) as [string, string]));
    let payload = semi < 0 ? "" : rest.slice(semi + 1);
    const kind = meta.get("p") ?? "title";
    if (kind !== "title" && kind !== "body") return null;
    if (meta.get("e") === "1") {
      try {
        payload = Buffer.from(payload, "base64").toString("utf8");
      } catch {
        return null;
      }
    }
    const id = meta.get("i") ?? "";
    const n = this.#kitty.get(id) ?? { title: "", body: "" };
    n[kind] += payload;
    if (meta.get("d") === "0") {
      if (this.#kitty.size < 32) this.#kitty.set(id, n);
      return null;
    }
    this.#kitty.delete(id);
    return n.title || n.body ? { type: "notify", title: n.title, body: n.body } : null;
  }
}

/** CSI c / CSI 0 c: primary device attributes; CSI > c / CSI > 0 c: secondary. */
function deviceQuery(params: string): OscEvent | null {
  if (params === "" || params === "0") return { type: "query", query: "da1" };
  if (params === ">" || params === ">0") return { type: "query", query: "da2" };
  return null;
}

/**
 * The replies, the same as the UI's terminal would give: VT220 with Sixel (4),
 * selective erase (9) and ANSI color (22); xterm.js's secondary attributes.
 */
export const DEVICE_REPLIES = { da1: "\x1b[?62;4;9;22c", da2: "\x1b[>0;276;0c" } as const;

/** `state;value` of OSC 9;4: 0 removes the bar, 1 sets it, 2 error, 3 indeterminate, 4 paused. */
function parseProgress(args: string): OscEvent | null {
  const [st, pr = ""] = args.split(";");
  const state = ({ "0": null, "1": "normal", "2": "error", "3": "indeterminate", "4": "paused" } as const)[st || "0"];
  if (state === undefined) return null;
  if (state === null) return { type: "progress", progress: null };
  const n = Number.parseInt(pr, 10);
  // -1: no value given (error and paused keep the one they had).
  const value = Number.isFinite(n) ? Math.max(0, Math.min(100, n)) : -1;
  return { type: "progress", progress: { state, value } };
}

export function parseOsc(body: string): OscEvent | null {
  const semi = body.indexOf(";");
  const code = semi < 0 ? body : body.slice(0, semi);
  const rest = semi < 0 ? "" : body.slice(semi + 1);
  switch (code) {
    case "0":
    case "2":
      return { type: "title", title: rest };
    case "7": {
      try {
        const url = new URL(rest);
        if (url.protocol !== "file:") return null;
        return { type: "cwd", cwd: decodeURIComponent(url.pathname) };
      } catch {
        return null;
      }
    }
    case "9":
      // OSC 9;4 is ConEmu progress, not a notification
      if (/^4(;|$)/.test(rest)) return parseProgress(rest.slice(2));
      return { type: "notify", title: "", body: rest };
    case "777": {
      const [kind, title = "", ...bodyParts] = rest.split(";");
      if (kind === "cmd") {
        // cmd shell integration request; the argument may itself contain ";".
        const [action = "", ...arg] = bodyParts;
        return { type: "request", token: title, action, arg: arg.join(";") };
      }
      if (kind !== "notify") return null;
      return { type: "notify", title, body: bodyParts.join(";") };
    }
    case "133": {
      const [mark = "", arg] = rest.split(";");
      const code = mark === "D" && arg !== undefined && /^-?\d+$/.test(arg) ? Number(arg) : undefined;
      return code === undefined ? { type: "prompt", mark } : { type: "prompt", mark, exitCode: code };
    }
    default:
      return null;
  }
}

/** Strip ANSI escape sequences (CSI, OSC, single-char escapes). */
export function stripAnsi(s: string): string {
  return s
    .replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, "")
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, "")
    .replace(/\x1b[@-Z\\-_]/g, "")
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "");
}
