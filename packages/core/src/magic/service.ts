// Magic windows in the core: runs the agent for a window (runMagic), streams
// its progress to the UI (magic.stream), stores the result in the window's
// state, and refreshes each widget's data source on its interval (magic.data).
// The agent is never involved in a refresh.

import os from "node:os";
import { logger } from "@cmd/protocol/node";
import { MAGIC_PROVIDERS, requestedMedia, type AppWindow, type CoreEvent, type MagicModel, type MagicState, type MagicStep, type SecretKey, type Settings, type WindowId } from "@cmd/protocol";
import { backendFor, isProvider, type Backend } from "./backends.ts";
import { listModels } from "./models.ts";
import { DEFAULT_DENY_PATHS } from "./policy.ts";
import { runMagic, type MagicEvent } from "./run.ts";
import type { Workspace } from "./prompt.ts";
import { sandboxAvailable, type SandboxMode } from "./sandbox.ts";
import { runSource, type SourceResult } from "./sources.ts";

const log = logger("magic");

/** What the service needs from the core's window manager. */
export interface MagicWindows {
  others(): AppWindow[];
  update(id: WindowId, patch: { title?: string; state?: Record<string, unknown> }): AppWindow;
  on(event: "removed", fn: (id: WindowId) => void): unknown;
}

export interface MagicServiceOptions {
  windows: MagicWindows;
  settings: () => Settings;
  /** The user's stored API keys (SecretsService). */
  secret: (key: SecretKey) => string | undefined;
  broadcast: (e: CoreEvent) => void;
  /** Tests inject a fake; default: the provider and model in the magic.* settings, with the provider's stored key. */
  backend?: (s: Settings) => Backend;
  /** Tests: the model list (default: the provider's /v1/models). */
  listModels?: typeof listModels;
  sandbox?: SandboxMode;
  /** Where a window's agent and source commands run (its Space's root); default: home. */
  cwdFor?: (w: AppWindow) => string;
  /** The window's Space, unless it is Home: named in the request, so "this project" means its folder. */
  workspaceFor?: (w: AppWindow) => Workspace | null;
}

const PERSIST_DATA_MS = 60_000;
const MODELS_TTL_MS = 10 * 60_000;
const BODY_THROTTLE_MS = 80;
/** The shortest interval a source runs at. */
const MIN_REFRESH_S = 2;

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
  /** Model lists per provider and key, so the settings popup opens instantly. */
  #models = new Map<string, { at: number; list: Promise<MagicModel[]> }>();

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

    const refining = !!(prev.prompt && (prev.answer || prev.html || prev.command) && (prev.phase === "ready" || prev.phase === "error"));
    const original = refining ? prev.prompt : text;
    const request = refining ? refineRequest(prev, text) : text;
    // A fresh run (not a refinement) starts the history over.
    const history = refining ? [...(prev.history ?? [prev.prompt]), text] : [text];
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
          log.debug(`run ${id.slice(0, 8)} ${e.tool}: ${e.why}`, step.detail ?? "");
          send({ type: "step", step });
          break;
        }
        case "step-end": {
          const step = steps.find((s) => s.id === e.id);
          if (!step) break;
          step.ms = e.ms;
          step.isError = e.isError;
          log.debug(`run ${id.slice(0, 8)} ${step.tool} done`, { ms: e.ms, error: e.isError });
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
          log.info(`run ${id.slice(0, 8)} repairing: ${e.reason.split("\n")[0]}`);
          send({ type: "repair", reason: e.reason.split("\n")[0]! });
          break;
      }
    };

    const s = this.#o.settings();
    let backend: Backend;
    try {
      backend = (this.#o.backend ?? ((x: Settings) => this.#backend(x)))(s);
    } catch (e) {
      this.#fail(id, prev, (e as Error).message);
      return;
    }
    log.info(`run ${id.slice(0, 8)}${refining ? " (refine)" : ""}`, { provider: s["magic.provider"], model: s[MAGIC_PROVIDERS[s["magic.provider"]].modelSetting] || "default" });
    void runMagic({
      prompt: request,
      backend,
      cwd: this.#cwd(w),
      workspace: this.#o.workspaceFor?.(w) ?? null,
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
        log.info(`run ${id.slice(0, 8)} finished`, {
          ok: r.ok,
          usable: !!usable,
          route: r.route,
          kind: r.header?.kind ?? null,
          backend: r.backend,
          model: r.model,
          ms: r.timings.done,
          firstStepMs: r.timings.firstStep ?? null,
          headerMs: r.timings.header ?? null,
          steps: steps.length,
          repairs: r.repairs.length,
          tokens: { in: r.usage.input, out: r.usage.output, cacheRead: r.usage.cacheRead, cacheWrite: r.usage.cacheWrite },
          costUSD: r.usage.costUSD ?? null,
          ...(r.errors.length ? { errors: r.errors.length, firstError: r.errors[0]!.split("\n")[0] } : {}),
        });
        if (!usable) return this.#fail(id, prev, r.errors[0]?.split("\n")[0] ?? "The answer couldn't be used.");
        if (r.route === "json") {
          this.#o.windows.update(id, {
            title: "JSON",
            state: { phase: "ready", kind: "widget", html: JSON_VIEW, media: [], source: null, refresh: 0, size: "m", lastData: { data: r.data, at: Date.now() }, steps, answer: undefined },
          });
          send({ type: "done" });
          return;
        }
        const h = r.header!;
        // An interval the person chose survives refinements.
        const keepRefresh = refining && !!prev.refreshByUser;
        const refresh = keepRefresh ? (prev.refresh ?? 0) : h.refresh;
        this.#o.windows.update(id, {
          title: h.title,
          state: {
            phase: "ready",
            kind: h.kind,
            html: r.body,
            source: h.source,
            refresh,
            refreshByUser: keepRefresh || undefined,
            size: h.size,
            command: h.command,
            media: h.media ?? [],
            lastData: r.sample?.ok ? { data: r.sample.data, at: Date.now() } : null,
            error: r.ok ? undefined : r.errors[0]?.split("\n")[0],
            steps,
            answer: r.answer || undefined,
          },
        });
        send({ type: "done" });
        this.#persistedAt.set(id, Date.now());
        if (h.source && refresh) this.#schedule(id, refresh * 1000);
      })
      .catch((e: Error) => {
        if (bodyTimer) clearTimeout(bodyTimer);
        if (this.#runs.get(id) !== ac) return;
        this.#runs.delete(id);
        this.#fail(id, prev, ac.signal.aborted ? "Stopped." : e.message);
      });
  }

  #backend(s: Settings): Backend {
    const p = MAGIC_PROVIDERS[s["magic.provider"]];
    return backendFor({ provider: s["magic.provider"], model: s[p.modelSetting], apiKey: this.#o.secret(p.keySecret) });
  }

  /** The models `provider` offers to the user's stored key, newest first; cached for a while (refresh: ask again). */
  async models(provider: string, refresh = false): Promise<MagicModel[]> {
    if (!isProvider(provider)) throw new Error(`unknown provider "${provider}"`);
    const key = this.#o.secret(MAGIC_PROVIDERS[provider].keySecret);
    if (!key) throw new Error(`No ${MAGIC_PROVIDERS[provider].title} API key`);
    const cacheKey = `${provider} ${key}`;
    const hit = this.#models.get(cacheKey);
    if (hit && !refresh && Date.now() - hit.at < MODELS_TTL_MS) return hit.list;
    const list = (this.#o.listModels ?? listModels)(provider, key);
    this.#models.set(cacheKey, { at: Date.now(), list });
    list.catch((e: Error) => {
      log.warn(`listing ${provider} models failed: ${e.message}`);
      if (this.#models.get(cacheKey)?.list === list) this.#models.delete(cacheKey); // errors aren't cached
    });
    return list;
  }

  #fail(id: WindowId, prev: MagicState, message: string): void {
    log.warn(`run ${id.slice(0, 8)} failed: ${message}`);
    this.#runs.delete(id);
    // A failed refinement keeps the widget that worked.
    if (prev.phase === "ready" && (prev.html || prev.command)) {
      this.#o.windows.update(id, { state: { phase: "ready", error: message } });
      this.#schedule(id, 0);
    } else {
      // The request being run is in the state by now (prev is from before it).
      const asked = this.#o.windows.others().find((x) => x.id === id);
      const prompt = asked ? stateOf(asked).prompt : prev.prompt;
      this.#o.windows.update(id, { state: { phase: prompt ? "error" : "empty", error: message } });
    }
    this.#o.broadcast({ type: "magic.stream", id, progress: { type: "error", message } });
  }

  /** The person's answer to the widget's media request: allow or decline the origins it asks for. */
  media(id: WindowId, allow: boolean): void {
    const s = stateOf(this.#window(id));
    const asked = requestedMedia(s);
    const allowed = s.mediaAllowed ?? [];
    const denied = s.mediaDenied ?? [];
    const union = (a: string[], b: string[]) => [...new Set([...a, ...b])];
    this.#o.windows.update(id, {
      state: allow
        ? { mediaAllowed: union(allowed, asked), mediaDenied: denied.filter((o) => !asked.includes(o)) }
        : { mediaDenied: union(denied, asked.filter((o) => !allowed.includes(o))) },
    });
  }

  cancel(id: WindowId): void {
    this.#runs.get(id)?.abort();
  }

  /** Run the source now (the refresh button), then continue on the interval. */
  refresh(id: WindowId): void {
    this.#window(id);
    this.#schedule(id, 0);
  }

  /** The person's interval for the source (Refresh Every); 0 runs it only on Refresh Now. */
  setRefresh(id: WindowId, seconds: number): void {
    if (!Number.isFinite(seconds) || seconds < 0) throw new Error(`magic.setRefresh: bad interval ${seconds}`);
    const refresh = seconds === 0 ? 0 : Math.max(MIN_REFRESH_S, Math.round(seconds));
    const s = stateOf(this.#window(id));
    this.#o.windows.update(id, { state: { refresh, refreshByUser: true } });
    if (!s.source || s.phase !== "ready") return;
    if (refresh) this.#schedule(id, refresh * 1000);
    else this.stop(id);
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
    const t0 = Date.now();
    const r: SourceResult = await runSource(s.source, { cwd: this.#cwd(w), deny: DEFAULT_DENY_PATHS, sandbox: this.#sandbox() });
    if (r.ok) log.debug(`data ${id.slice(0, 8)} refreshed`, { ms: Date.now() - t0 });
    else log.warn(`data ${id.slice(0, 8)} failed (${(this.#failures.get(id) ?? 0) + 1} in a row): ${(r.error ?? "failed").split("\n")[0]}`, { ms: Date.now() - t0 });
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
    this.#schedule(id, Math.max(MIN_REFRESH_S, s.refresh) * 1000 * factor);
  }
}

/**
 * A refinement's request: everything the person asked so far (the first request
 * and each change, in order, so details from any of them survive), the new
 * change, and what the window is now.
 */
export function refineRequest(prev: MagicState, change: string): string {
  const asked = prev.history?.length ? prev.history : [prev.prompt];
  const earlier = asked.length === 1 ? `The window was made from this request:\n${asked[0]}` : `The window was made from these requests, in order (the first, then changes):\n${asked.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
  const current = prev.answer
    ? `Its current answer (header and view):\n${prev.answer}`
    : prev.kind === "terminal" && prev.command
      ? `It currently runs the terminal command: ${prev.command}`
      : prev.html
        ? `Its current view:\n${prev.html}`
        : "";
  return [
    earlier,
    `Change it as asked, keeping what still fits and everything those requests asked for that the change doesn't override: ${change}`,
    current,
  ]
    .filter(Boolean)
    .join("\n\n");
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
