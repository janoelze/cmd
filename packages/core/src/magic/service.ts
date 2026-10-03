// Magic windows in the core: runs the agent for a window (runMagic), streams
// its progress to the UI (magic.stream), stores the result in the window's
// state, and refreshes each widget's data source on its interval (magic.data).
// The agent is never involved in a refresh.

import os from "node:os";
import type { AppWindow, CoreEvent, MagicState, MagicStep, Settings, WindowId } from "@cmd/protocol";
import { backendFor, type Backend } from "./backends.ts";
import { DEFAULT_DENY_PATHS } from "./policy.ts";
import { runMagic, type MagicEvent } from "./run.ts";
import { sandboxAvailable, type SandboxMode } from "./sandbox.ts";
import { runSource, type SourceResult } from "./sources.ts";

/** What the service needs from the core's window manager. */
export interface MagicWindows {
  others(): AppWindow[];
  update(id: WindowId, patch: { title?: string; state?: Record<string, unknown> }): AppWindow;
  on(event: "removed", fn: (id: WindowId) => void): unknown;
}

export interface MagicServiceOptions {
  windows: MagicWindows;
  settings: () => Settings;
  broadcast: (e: CoreEvent) => void;
  /** Tests inject a fake; default: from the magic.* settings. */
  backend?: (s: Settings) => Backend;
  sandbox?: SandboxMode;
  /** Where a window's agent and source commands run (its Space's root); default: home. */
  cwdFor?: (w: AppWindow) => string;
}

const PERSIST_DATA_MS = 60_000;
const BODY_THROTTLE_MS = 80;

const stateOf = (w: AppWindow) => w.state as MagicState;

function detailOf(tool: string, input: Record<string, unknown>): string {
  const src = input.source as { url?: string; command?: string } | undefined;
  const v = input.command ?? input.path ?? input.url ?? src?.command ?? src?.url ?? "";
  return String(v).replace(/\s+/g, " ").slice(0, 160) || tool;
}

export class MagicService {
  #o: MagicServiceOptions;
  #runs = new Map<WindowId, AbortController>();
  #timers = new Map<WindowId, ReturnType<typeof setTimeout>>();
  #failures = new Map<WindowId, number>();
  #persistedAt = new Map<WindowId, number>();

  constructor(o: MagicServiceOptions) {
    this.#o = o;
    o.windows.on("removed", (id) => this.stop(id));
    for (const w of o.windows.others()) {
      if (w.kind !== "magic") continue;
      const s = stateOf(w);
      // A run can't survive the core; say so instead of spinning forever.
      if (s.phase === "working") o.windows.update(w.id, { state: { phase: s.html ? "ready" : "error", error: "Interrupted: cmd restarted while this was being made." } });
      else if (s.phase === "ready") this.#schedule(w.id, 0);
    }
  }

  #window(id: WindowId): AppWindow {
    const w = this.#o.windows.others().find((x) => x.id === id);
    if (!w || w.kind !== "magic") throw new Error(`not a Magic window: ${id}`);
    return w;
  }

  #cwd(w: AppWindow): string {
    return this.#o.cwdFor?.(w) ?? os.homedir();
  }

  #sandbox(): SandboxMode {
    if (this.#o.sandbox) return this.#o.sandbox;
    return process.env.CMD_MAGIC_UNSANDBOXED === "1" && !sandboxAvailable() ? "off" : "required";
  }

  /** Make (or, for a window that already shows something, refine) the window from a request. */
  run(id: WindowId, prompt: string): void {
    const text = prompt.trim();
    if (!text) throw new Error("magic.run: empty request");
    const w = this.#window(id);
    const prev = stateOf(w);
    this.#runs.get(id)?.abort();
    this.stop(id);
    const ac = new AbortController();
    this.#runs.set(id, ac);

    const refining = !!(prev.answer && (prev.phase === "ready" || prev.phase === "error"));
    const original = refining ? prev.prompt : text;
    const request = refining
      ? `${original}\n\nThis window already exists. Change it as asked, keeping what still fits: ${text}\n\nIts current answer (header and view):\n${prev.answer}`
      : text;
    const history = [...(prev.history ?? []), text];
    this.#o.windows.update(id, { title: refining ? w.title : "Magic", state: { prompt: original, phase: "working", error: undefined, steps: [], history } });

    const steps: MagicStep[] = [];
    let lastBody = 0;
    let pendingBody: string | null = null;
    let bodyTimer: ReturnType<typeof setTimeout> | null = null;
    const send = (progress: Extract<CoreEvent, { type: "magic.stream" }>["progress"]) => this.#o.broadcast({ type: "magic.stream", id, progress });
    const flushBody = () => {
      bodyTimer = null;
      if (pendingBody === null) return;
      lastBody = Date.now();
      send({ type: "body", html: pendingBody });
      pendingBody = null;
    };
    const onEvent = (e: MagicEvent) => {
      switch (e.type) {
        case "step-start": {
          const step: MagicStep = { id: e.id, tool: e.tool, why: e.why, detail: detailOf(e.tool, e.input) };
          steps.push(step);
          send({ type: "step", step });
          break;
        }
        case "step-end": {
          const step = steps.find((s) => s.id === e.id);
          if (!step) break;
          step.ms = e.ms;
          step.isError = e.isError;
          step.output = e.output.slice(0, 4000);
          send({ type: "step", step: { ...step } });
          break;
        }
        case "header":
          if (!refining) this.#o.windows.update(id, { title: e.header.title });
          send({ type: "header", title: e.header.title, loading: e.header.loading, kind: e.header.kind, size: e.header.size });
          break;
        case "body":
          pendingBody = e.body;
          if (Date.now() - lastBody >= BODY_THROTTLE_MS) flushBody();
          else bodyTimer ??= setTimeout(flushBody, BODY_THROTTLE_MS);
          break;
        case "repair":
          send({ type: "repair", reason: e.reason.split("\n")[0]! });
          break;
      }
    };

    const s = this.#o.settings();
    let backend: Backend;
    try {
      backend = (this.#o.backend ?? ((x: Settings) => backendFor({ provider: x["magic.provider"], model: x["magic.model"], baseURL: x["magic.baseUrl"] || undefined })))(s);
    } catch (e) {
      this.#fail(id, prev, (e as Error).message);
      return;
    }
    void runMagic({
      prompt: request,
      backend,
      cwd: this.#cwd(w),
      explore: s["magic.explore"],
      sandbox: this.#sandbox(),
      deny: DEFAULT_DENY_PATHS,
      noFast: refining,
      signal: ac.signal,
      onEvent,
    })
      .then((r) => {
        if (bodyTimer) clearTimeout(bodyTimer);
        if (this.#runs.get(id) !== ac) return; // superseded
        this.#runs.delete(id);
        const usable = r.ok || (r.header && (r.header.kind === "terminal" || r.body));
        if (!usable) return this.#fail(id, prev, r.errors[0]?.split("\n")[0] ?? "The answer couldn't be used.");
        if (r.route === "json") {
          this.#o.windows.update(id, {
            title: "JSON",
            state: { phase: "ready", kind: "widget", html: JSON_VIEW, source: null, refresh: 0, size: "m", lastData: { data: r.data, at: Date.now() }, steps, answer: undefined },
          });
          send({ type: "done" });
          return;
        }
        const h = r.header!;
        this.#o.windows.update(id, {
          title: h.title,
          state: {
            phase: "ready",
            kind: h.kind,
            html: r.body,
            source: h.source,
            refresh: h.refresh,
            size: h.size,
            command: h.command,
            lastData: r.sample?.ok ? { data: r.sample.data, at: Date.now() } : null,
            error: r.ok ? undefined : r.errors[0]?.split("\n")[0],
            steps,
            answer: r.answer || undefined,
          },
        });
        send({ type: "done" });
        this.#persistedAt.set(id, Date.now());
        if (h.source && h.refresh) this.#schedule(id, h.refresh * 1000);
      })
      .catch((e: Error) => {
        if (bodyTimer) clearTimeout(bodyTimer);
        if (this.#runs.get(id) !== ac) return;
        this.#runs.delete(id);
        this.#fail(id, prev, ac.signal.aborted ? "Stopped." : e.message);
      });
  }

  #fail(id: WindowId, prev: MagicState, message: string): void {
    this.#runs.delete(id);
    // A failed refinement keeps the widget that worked.
    if (prev.phase === "ready" && (prev.html || prev.command)) {
      this.#o.windows.update(id, { state: { phase: "ready", error: message } });
      this.#schedule(id, 0);
    } else {
      this.#o.windows.update(id, { state: { phase: prev.prompt ? "error" : "empty", error: message } });
    }
    this.#o.broadcast({ type: "magic.stream", id, progress: { type: "error", message } });
  }

  cancel(id: WindowId): void {
    this.#runs.get(id)?.abort();
  }

  /** Run the source now (the refresh button), then continue on the interval. */
  refresh(id: WindowId): void {
    this.#window(id);
    this.#schedule(id, 0);
  }

  stop(id: WindowId): void {
    clearTimeout(this.#timers.get(id));
    this.#timers.delete(id);
  }

  dispose(): void {
    for (const ac of this.#runs.values()) ac.abort();
    for (const t of this.#timers.values()) clearTimeout(t);
    this.#runs.clear();
    this.#timers.clear();
  }

  #schedule(id: WindowId, delay: number): void {
    this.stop(id);
    this.#timers.set(
      id,
      setTimeout(() => void this.#tick(id), delay),
    );
  }

  async #tick(id: WindowId): Promise<void> {
    let w: AppWindow;
    try {
      w = this.#window(id);
    } catch {
      return this.stop(id);
    }
    const s = stateOf(w);
    if (!s.source || s.phase !== "ready") return;
    const r: SourceResult = await runSource(s.source, { cwd: this.#cwd(w), deny: DEFAULT_DENY_PATHS, sandbox: this.#sandbox() });
    if (!this.#o.windows.others().some((x) => x.id === id)) return;
    const at = Date.now();
    if (r.ok) {
      this.#failures.delete(id);
      this.#o.broadcast({ type: "magic.data", id, data: r.data, at });
      if (at - (this.#persistedAt.get(id) ?? 0) >= PERSIST_DATA_MS) {
        this.#persistedAt.set(id, at);
        this.#o.windows.update(id, { state: { lastData: { data: r.data, at } } });
      }
    } else {
      this.#failures.set(id, (this.#failures.get(id) ?? 0) + 1);
      this.#o.broadcast({ type: "magic.data", id, data: null, at, error: r.error ?? "failed" });
    }
    if (!s.refresh) return;
    // Back off on failures, up to 10× the interval.
    const factor = Math.min(10, 2 ** (this.#failures.get(id) ?? 0));
    this.#schedule(id, Math.max(2, s.refresh) * 1000 * factor);
  }
}

/** The no-model view of pasted JSON: a collapsible tree. */
const JSON_VIEW = `<style>.t{font:12px/1.5 var(--mono)}.t details{padding-left:14px}.t summary{cursor:default;list-style:none;margin-left:-14px}.t summary::before{content:"▸ ";color:var(--text-dim)}.t details[open]>summary::before{content:"▾ "}.k{color:var(--c1)}.s{color:var(--c2)}.n{color:var(--c3)}.b{color:var(--c4)}</style>
<div class="t" id="root"></div>
<script>
const esc=s=>String(s).replace(/[&<>]/g,c=>({"&":"&amp;","<":"&lt;",">":"&gt;"})[c]);
function node(k,v,open){const key=k===null?"":'<span class="k">'+esc(k)+'</span>: ';
if(v&&typeof v==="object"){const arr=Array.isArray(v),n=arr?v.length:Object.keys(v).length;const d=document.createElement("details");if(open)d.open=true;d.innerHTML="<summary>"+key+'<span class="k-dim">'+(arr?"["+n+"]":"{"+n+"}")+"</span></summary>";for(const [ck,cv] of Object.entries(v))d.append(node(arr?Number(ck):ck,cv,false));return d;}
const e=document.createElement("div");const cls=typeof v==="string"?"s":typeof v==="number"?"n":"b";e.innerHTML=key+'<span class="'+cls+'">'+esc(JSON.stringify(v))+"</span>";return e;}
cmd.onData(d=>root.replaceChildren(node(null,d,true)));
</script>`;
