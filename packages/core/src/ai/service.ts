// AiService (docs/17-ai.md): the one way any part of the core uses a model.
// It knows which providers have keys (secrets) and whether they work, resolves
// a tier to a model (pinned in settings, else the newest of the tier's family
// the key can use, else a known fallback), and runs calls: an agent loop
// (Magic), a text completion or an object. Every call names its purpose for
// the log. Background calls (nobody is waiting) share a small limit, so they
// can't flood a provider or slow down a run the user is watching.
//
// Each key's model list is kept in $CMD_HOME/ai-models.json, so tiers resolve
// at startup and offline; it is listed again when the key changes and daily.

import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";
import { EventEmitter } from "node:events";
import type { ContextRecord } from "./context.ts";
import { logger } from "@cmd/protocol/node";
import {
  AI_PROVIDER_IDS,
  AI_PROVIDERS,
  AUTO_MODEL,
  isAiProvider,
  type AiModel,
  type AiModelChoice,
  type AiProvider,
  type AiProviderStatus,
  type AiStatus,
  type AiTier,
  type Settings,
} from "@cmd/protocol";
import type { SecretsService } from "../secrets.ts";
import { aiBackend, completeObject, completeText, type AiBackendOptions, type Backend, type CompleteRequest, type CompleteResult, type ObjectRequest, type Usage } from "./backends.ts";
import { FALLBACK_MODELS, KeyRejected, listModels, pickModel } from "./models.ts";

const log = logger("ai");

/** Model lists older than this are listed again (in the background). */
const STALE_MS = 24 * 3600_000;
/** ai.models answers from the cache when it is this fresh (the popup opens instantly). */
const POPUP_TTL_MS = 10 * 60_000;
/** Background calls at once, across all features. */
const BACKGROUND_LIMIT = 2;

/** No provider has a key that works: AI features say so instead of failing. */
export class AiNotConfigured extends Error {
  constructor() {
    super("No AI provider is set up. Add an API key in Settings → AI.");
  }
}

export interface AiServiceOptions {
  settings: () => Settings;
  secrets: SecretsService;
  /** Where ai-models.json lives; null: in memory (tests, the CLI writes it too). */
  stateDir: string | null;
  /** Tests: the model list (default: the provider's /v1/models). */
  listModels?: typeof listModels;
  /** Every call, when it ended: for the event log (ai.call) and cost totals. */
  onCall?: (call: AiCallRecord) => void;
}

/** What one model call was: for the log. Input and output are the texts sent and received, when the call had them. */
export interface AiCallRecord {
  purpose: string;
  provider: AiProvider;
  model: string;
  tier: AiTier;
  ms: number;
  usage: Usage | null;
  ok: boolean;
  error?: string;
  input?: string;
  output?: string;
  context?: ContextRecord;
}

export interface CallOptions {
  tier: AiTier;
  /** What the call is for, for the log and per-feature totals: "magic", "notify.agentDone". */
  purpose: string;
  /** Nobody is waiting on it: it queues behind other background calls. */
  background?: boolean;
  /** Overrides (the CLI's --provider/--model/--effort). */
  provider?: AiProvider;
  model?: string;
  effort?: AiBackendOptions["effort"];
  /** What the input was built from (ai/context.ts), recorded with the call. */
  context?: ContextRecord;
}

interface Cached {
  /** Which key the list is for (a hash; the key itself stays in secrets.json). */
  key: string;
  at: number;
  list: AiModel[];
}

const hashKey = (key: string) => createHash("sha256").update(key).digest("hex").slice(0, 16);

/** Whether an AI SDK error means the provider refused the key. */
const isAuthError = (e: unknown) => e instanceof KeyRejected || (e as { statusCode?: number } | null)?.statusCode === 401;

class Limiter {
  #running = 0;
  #queue: (() => void)[] = [];
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#running >= this.max) await new Promise<void>((r) => this.#queue.push(r));
    this.#running++;
    try {
      return await fn();
    } finally {
      this.#running--;
      this.#queue.shift()?.();
    }
  }
}

export class AiService extends EventEmitter<{ updated: [AiStatus] }> {
  #o: AiServiceOptions;
  #file: string | null;
  #cache: Partial<Record<AiProvider, Cached>>;
  /** Per provider: the key hash last seen, and what is known about that key. */
  #seen: Partial<Record<AiProvider, string | null>> = {};
  #state: Partial<Record<AiProvider, { state: AiProviderStatus["state"]; error?: string }>> = {};
  #listing = new Map<AiProvider, Promise<AiModel[]>>();
  #background = new Limiter(BACKGROUND_LIMIT);
  #timer: ReturnType<typeof setInterval> | null = null;

  constructor(o: AiServiceOptions) {
    super();
    this.#o = o;
    this.#file = o.stateDir ? path.join(o.stateDir, "ai-models.json") : null;
    this.#cache = this.#readCache();
    for (const p of AI_PROVIDER_IDS) this.#keyChanged(p);
    o.secrets.on("updated", () => {
      if (AI_PROVIDER_IDS.map((p) => this.#keyChanged(p)).some(Boolean)) this.#emit();
    });
  }

  /** Check keys never checked or not lately, now and every few hours (the core calls this; the CLI doesn't). */
  start(): void {
    const check = () => {
      for (const p of AI_PROVIDER_IDS) {
        const c = this.#cache[p];
        if (this.#key(p) && (this.#state[p]?.state === "unchecked" || !c || Date.now() - c.at > STALE_MS)) void this.#list(p).catch(() => {});
      }
    };
    check();
    this.#timer = setInterval(check, 3 * 3600_000);
    this.#timer.unref?.();
  }

  dispose(): void {
    if (this.#timer) clearInterval(this.#timer);
  }

  /** Settings that change what tiers resolve to changed (the core binds ai.*). */
  settingsChanged(): void {
    this.#emit();
  }

  // ── status ─────────────────────────────────────────────

  status(): AiStatus {
    const providers = Object.fromEntries(AI_PROVIDER_IDS.map((p) => [p, this.#providerStatus(p)])) as AiStatus["providers"];
    const provider = this.provider();
    return { ready: provider !== null, provider, providers };
  }

  /** The provider calls use: ai.provider if its key is usable, else another one that is. */
  provider(): AiProvider | null {
    const usable = (p: AiProvider) => !!this.#key(p) && this.#state[p]?.state !== "rejected";
    const preferred = this.#o.settings()["ai.provider"];
    if (usable(preferred)) return preferred;
    return AI_PROVIDER_IDS.find(usable) ?? null;
  }

  /** The model `tier` uses with `provider`: pinned in settings, else picked from the key's list, else the fallback. */
  model(provider: AiProvider, tier: AiTier): AiModelChoice {
    const list = this.#cache[provider]?.list ?? [];
    const setting = String(this.#o.settings()[AI_PROVIDERS[provider].tiers[tier]] ?? "").trim();
    if (setting && setting !== AUTO_MODEL) return { id: setting, name: list.find((m) => m.id === setting)?.name ?? setting, auto: false };
    const picked = pickModel(provider, tier, list);
    if (picked) return { id: picked.id, name: picked.name, auto: true };
    const id = FALLBACK_MODELS[provider][tier];
    return { id, name: id, auto: true };
  }

  #providerStatus(p: AiProvider): AiProviderStatus {
    const key = this.#o.secrets.status()[AI_PROVIDERS[p].keySecret];
    if (!key.set) return { key, state: "none" };
    const st = this.#state[p] ?? { state: "unchecked" };
    return { key, state: st.state, error: st.error, models: { smart: this.model(p, "smart"), fast: this.model(p, "fast") } };
  }

  #emit(): void {
    this.emit("updated", this.status());
  }

  // ── keys ───────────────────────────────────────────────

  #key(p: AiProvider): string | undefined {
    return this.#o.secrets.get(AI_PROVIDERS[p].keySecret);
  }

  /** Notice a new, changed or removed key; true if it changed. A key the cache knows is known to work. */
  #keyChanged(p: AiProvider): boolean {
    const key = this.#key(p);
    const h = key ? hashKey(key) : null;
    if (p in this.#seen && this.#seen[p] === h) return false;
    this.#seen[p] = h;
    if (!h) this.#state[p] = { state: "none" };
    else if (this.#cache[p]?.key === h) this.#state[p] = { state: "ok" };
    else {
      this.#state[p] = { state: "unchecked" };
      if (this.#timer) void this.#list(p).catch(() => {});
    }
    return true;
  }

  /**
   * Check a key with the provider and store it. A refused key is not stored
   * (throws why); a key that can't be checked now is stored unchecked.
   */
  async connect(provider: string, key: string | null): Promise<AiStatus> {
    if (!isAiProvider(provider)) throw new Error(`unknown provider "${provider}"`);
    const secret = AI_PROVIDERS[provider].keySecret;
    const k = key?.trim();
    if (!k) {
      this.#o.secrets.set(secret, null);
      return this.status();
    }
    try {
      const list = await (this.#o.listModels ?? listModels)(provider, k);
      this.#remember(provider, k, list);
      log.info(`${provider} key added`, { models: list.length });
    } catch (e) {
      if (e instanceof KeyRejected) throw new Error(`${AI_PROVIDERS[provider].title} didn't accept this key.`);
      log.warn(`could not check the ${provider} key, storing it unchecked: ${(e as Error).message}`);
      this.#seen[provider] = hashKey(k);
      this.#state[provider] = { state: "unchecked", error: `Couldn't reach ${AI_PROVIDERS[provider].title} to check the key.` };
    }
    // The cache already knows the key, so the secrets event doesn't list again.
    this.#o.secrets.set(secret, k);
    this.#emit();
    return this.status();
  }

  // ── models ─────────────────────────────────────────────

  /** The models `provider` offers to the stored key, newest first (refresh: ask again). */
  async models(provider: string, refresh = false): Promise<AiModel[]> {
    if (!isAiProvider(provider)) throw new Error(`unknown provider "${provider}"`);
    const key = this.#key(provider);
    if (!key) throw new Error(`No ${AI_PROVIDERS[provider].title} API key`);
    const c = this.#cache[provider];
    if (!refresh && c?.key === hashKey(key) && Date.now() - c.at < POPUP_TTL_MS) return c.list;
    return this.#list(provider);
  }

  /** List the key's models (one request at a time per provider) and record what that says about the key. */
  #list(p: AiProvider): Promise<AiModel[]> {
    const running = this.#listing.get(p);
    if (running) return running;
    const key = this.#key(p);
    if (!key) return Promise.reject(new Error(`No ${AI_PROVIDERS[p].title} API key`));
    const run = (this.#o.listModels ?? listModels)(p, key)
      .then((list) => {
        if (this.#key(p) === key) this.#remember(p, key, list), this.#emit();
        return list;
      })
      .catch((e: Error) => {
        if (this.#key(p) === key) {
          if (e instanceof KeyRejected) this.#reject(p);
          else if (this.#state[p]?.state !== "ok") (this.#state[p] = { state: "unchecked", error: `Couldn't reach ${AI_PROVIDERS[p].title}: ${e.message}` }), this.#emit();
        }
        log.warn(`listing ${p} models failed: ${e.message}`);
        throw e;
      })
      .finally(() => this.#listing.delete(p));
    this.#listing.set(p, run);
    return run;
  }

  #remember(p: AiProvider, key: string, list: AiModel[]): void {
    const h = hashKey(key);
    this.#cache[p] = { key: h, at: Date.now(), list };
    this.#seen[p] = h;
    this.#state[p] = { state: "ok" };
    this.#writeCache();
  }

  #reject(p: AiProvider): void {
    if (this.#state[p]?.state === "rejected") return;
    log.warn(`${p} refused the stored key`);
    this.#state[p] = { state: "rejected", error: `${AI_PROVIDERS[p].title} no longer accepts this key.` };
    delete this.#cache[p];
    this.#writeCache();
    this.#emit();
  }

  #readCache(): Partial<Record<AiProvider, Cached>> {
    if (!this.#file) return {};
    try {
      const v = JSON.parse(fs.readFileSync(this.#file, "utf8")) as Record<string, Cached>;
      return Object.fromEntries(Object.entries(v).filter(([p, c]) => isAiProvider(p) && typeof c?.key === "string" && Array.isArray(c.list)));
    } catch {
      return {};
    }
  }

  #writeCache(): void {
    if (!this.#file) return;
    try {
      fs.mkdirSync(path.dirname(this.#file), { recursive: true });
      const tmp = `${this.#file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.#cache) + "\n", { mode: 0o600 });
      fs.renameSync(tmp, this.#file);
    } catch (e) {
      log.warn(`could not save the model lists: ${(e as Error).message}`);
    }
  }

  // ── calls ──────────────────────────────────────────────

  /** What a call runs on; throws AiNotConfigured when no provider is usable. */
  #choose(o: CallOptions): AiBackendOptions {
    const provider = o.provider ?? this.provider();
    if (!provider) throw new AiNotConfigured();
    const apiKey = this.#key(provider);
    if (!apiKey) throw new Error(`No ${AI_PROVIDERS[provider].title} API key. Add one in Settings → AI.`);
    return { provider, apiKey, model: o.model?.trim() || this.model(provider, o.tier).id, effort: o.effort };
  }

  /** Run a call: queued if in the background, logged, and a refused key marks the provider. */
  async #call<T>(o: CallOptions, b: AiBackendOptions, fn: () => Promise<{ usage: Usage; model: string } & T>, io?: { input: string; output: (r: T) => string }): Promise<T & { usage: Usage; model: string }> {
    const t0 = Date.now();
    try {
      const r = await (o.background ? this.#background.run(fn) : fn());
      log.info(o.purpose, { provider: b.provider, model: r.model, ms: Date.now() - t0, tokens: { in: r.usage.input, out: r.usage.output } });
      this.#o.onCall?.({ purpose: o.purpose, provider: b.provider, model: r.model, tier: o.tier, ms: Date.now() - t0, usage: r.usage, ok: true, input: io?.input, output: io ? safeOutput(() => io.output(r)) : undefined, context: o.context });
      return r;
    } catch (e) {
      if (isAuthError(e)) this.#reject(b.provider);
      log.warn(`${o.purpose} failed`, { provider: b.provider, model: b.model, error: (e as Error).message });
      this.#o.onCall?.({ purpose: o.purpose, provider: b.provider, model: b.model, tier: o.tier, ms: Date.now() - t0, usage: null, ok: false, error: (e as Error).message, input: io?.input, context: o.context });
      throw e;
    }
  }

  /** A backend for an agent loop (Magic's build). */
  backend(o: CallOptions): Backend {
    const b = this.#choose(o);
    const inner = aiBackend(b);
    return { name: inner.name, model: inner.model, run: (r) => this.#call(o, b, () => inner.run(r)) };
  }

  /** One answer as text. */
  complete(o: CallOptions & CompleteRequest): Promise<CompleteResult<string>> {
    const b = this.#choose(o);
    return this.#call(o, b, () => completeText(b, o), { input: inputText(o), output: (r) => r.value });
  }

  /** One answer as an object matching `schema` (JSON schema); streamed with `onPartial`. */
  object<T>(o: CallOptions & ObjectRequest<T>): Promise<CompleteResult<T>> {
    const b = this.#choose(o);
    return this.#call(o, b, () => completeObject<T>(b, o), { input: inputText(o), output: (r) => JSON.stringify(r.value) });
  }
}

const inputText = (o: CompleteRequest) => (o.system ? `${o.system}\n\n---\n\n` : "") + o.prompt;
const safeOutput = (fn: () => string) => {
  try {
    return fn();
  } catch {
    return undefined;
  }
};
