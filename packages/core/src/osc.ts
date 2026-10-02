// Incremental scanner for OSC sequences in PTY output.
// Sequences may be split across chunks, so state is carried between calls.

export type OscEvent =
  | { type: "title"; title: string } // OSC 0 / 2
  | { type: "cwd"; cwd: string } // OSC 7 file://host/path
  | { type: "notify"; title: string; body: string } // OSC 9 / OSC 777;notify
  | { type: "prompt"; mark: string }; // OSC 133 shell integration (A/B/C/D)

const ESC = "\x1b";
const BEL = "\x07";
const MAX_OSC = 8192;

export class OscScanner {
  #inOsc = false;
  #pendingEsc = false;
  #buf = "";

  feed(chunk: string): OscEvent[] {
    const out: OscEvent[] = [];
    for (let i = 0; i < chunk.length; i++) {
      const ch = chunk[i]!;
      if (!this.#inOsc) {
        if (this.#pendingEsc) {
          this.#pendingEsc = false;
          if (ch === "]") {
            this.#inOsc = true;
            this.#buf = "";
            continue;
          }
        }
        if (ch === ESC) this.#pendingEsc = true;
        continue;
      }
      // inside OSC: terminated by BEL or ST (ESC \)
      if (this.#pendingEsc) {
        this.#pendingEsc = false;
        if (ch === "\\") {
          this.#finish(out);
          continue;
        }
        this.#buf += ESC;
      }
      if (ch === BEL) {
        this.#finish(out);
      } else if (ch === ESC) {
        this.#pendingEsc = true;
      } else {
        this.#buf += ch;
        if (this.#buf.length > MAX_OSC) {
          this.#inOsc = false;
          this.#buf = "";
        }
      }
    }
    return out;
  }

  #finish(out: OscEvent[]): void {
    this.#inOsc = false;
    const ev = parseOsc(this.#buf);
    this.#buf = "";
    if (ev) out.push(ev);
  }
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
      if (/^4;/.test(rest)) return null;
      return { type: "notify", title: "", body: rest };
    case "777": {
      const [kind, title = "", ...bodyParts] = rest.split(";");
      if (kind !== "notify") return null;
      return { type: "notify", title, body: bodyParts.join(";") };
    }
    case "133":
      return { type: "prompt", mark: rest.split(";")[0] ?? "" };
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
