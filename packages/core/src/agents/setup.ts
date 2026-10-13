// cmd's hook in the agents' configs, and where agents keep them (docs/18): the hook files this
// build writes, finding agent homes (at startup, every few hours, when agents.homes changes, and
// from what hooks and transcripts report), and putting the hook into configs that lack it.

import type { AgentHome, HookTarget } from "@cmd/protocol";
import { logger } from "@cmd/protocol/node";
import type { CoreContext } from "../kernel/context.ts";
import { hookFiles, hookState, hookTargets, installHooks, removeHooks, setBriefingFlag, writeHookFiles, type HookFiles } from "./hooks.ts";

const log = logger("core");

/** ui_state key: agent configs the user removed cmd's hook from. */
const DECLINED_KEY = "core.hooks.declined";

/** cmd's hook script and CLI wrapper for agents, rewritten for this build (agents/hooks.ts); null when it can't be written. */
export function writeAgentHooks(core: Pick<CoreContext, "settings">, stateDir: string): HookFiles | null {
  const files = hookFiles(stateDir);
  try {
    writeHookFiles(files);
    core.settings.bind(["agents.integration"], () => setBriefingFlag(files, core.settings.settings["agents.integration"]));
    return files;
  } catch (err) {
    log.error(`could not write the agent hook: ${(err as Error).message}`);
    return null;
  }
}

type SetupCore = Pick<CoreContext, "settings" | "store" | "homes" | "agents" | "notifications" | "search">;

export class AgentSetup {
  #core: SetupCore;
  #hooks: HookFiles | null;
  #auto: boolean;
  #discovered = false;
  #timer: NodeJS.Timeout | undefined;
  #closed = false;

  /** `rediscover`: look for homes every few hours and when agents.homes changes (real cores); `auto`: install the hook (the installed app only). */
  constructor(core: SetupCore, hooks: HookFiles | null, o: { auto: boolean; rediscover: boolean }) {
    this.#core = core;
    this.#hooks = hooks;
    this.#auto = o.auto;
    core.agents.on("home", (agent, dir) => this.newHome(core.homes.learn(agent, dir, "hook")));
    core.agents.on("transcript", (agent, file) => {
      const dir = core.homes.homeOfTranscript(agent, file);
      if (dir) this.newHome(core.homes.learn(agent, dir, "transcript"));
    });
    if (o.rediscover) {
      this.#timer = setInterval(() => this.discover(), 6 * 3600_000);
      this.#timer.unref();
      // (bind also runs once now: these wait for the startup discovery instead)
      core.settings.bind(["agents.homes"], () => this.#discovered && this.discover());
      core.settings.bind(["agents.hooks.auto"], () => this.#discovered && this.#autoHooks());
    }
  }

  /** Whether homes were looked for since the core started. */
  get discovered(): boolean {
    return this.#discovered;
  }

  /** Look for agent homes; their transcripts are read, and they may get the hook. */
  discover(): void {
    if (this.#closed) return;
    this.#discovered = true;
    try {
      for (const h of this.#core.homes.discover()) this.#core.search.learnHome(h.agent, h.dir);
    } catch (err) {
      log.error(`looking for agent homes: ${(err as Error).message}`);
    }
    this.#autoHooks();
  }

  /** A home cmd didn't know: its transcripts are indexed, and it may get the hook. */
  newHome(h: AgentHome | null): void {
    if (!h) return;
    this.#core.search.learnHome(h.agent, h.dir);
    if (this.#discovered) this.#autoHooks();
  }

  /** The agent configs cmd's hook can go into, and whether it is there. */
  targets(): HookTarget[] {
    if (!this.#hooks) return [];
    const script = this.#hooks.script;
    if (!this.#discovered) {
      this.#discovered = true;
      for (const h of this.#core.homes.discover()) this.#core.search.learnHome(h.agent, h.dir);
    }
    const declined = this.#declined();
    return hookTargets(this.#core.homes.all()).map((t) => ({ ...t, state: hookState(t.agent, t.file, script), ...(declined.has(t.file) ? { declined: true } : {}) }));
  }

  install(file: string): HookTarget[] {
    const t = this.#target(file);
    installHooks(t.agent, t.file, this.#hooks!.script);
    this.#setDeclined(t.file, false);
    return this.targets();
  }

  remove(file: string): HookTarget[] {
    const t = this.#target(file);
    removeHooks(t.file);
    this.#setDeclined(t.file, true);
    return this.targets();
  }

  dispose(): void {
    this.#closed = true;
    clearInterval(this.#timer);
  }

  /** Only the agent configs hooks.status lists can be written. */
  #target(file: string): HookTarget {
    const t = this.targets().find((x) => x.file === file);
    if (!t) throw new Error(`not an agent config cmd installs hooks into: ${file}`);
    return t;
  }

  /** Configs the user took cmd's hook out of (hooks.remove): automatic installs leave them alone. */
  #declined(): Set<string> {
    const v = this.#core.store.uiState()[DECLINED_KEY];
    return new Set(Array.isArray(v) ? (v as string[]) : []);
  }

  #setDeclined(file: string, on: boolean): void {
    const d = this.#declined();
    if (on) d.add(file);
    else d.delete(file);
    this.#core.store.setUiState(DECLINED_KEY, d.size ? [...d] : null);
  }

  /**
   * Out of the box: cmd's hook in every agent config without one, an old one
   * (`cmd hook`, this cmd's in an older form) or a broken one (its script gone). Never over
   * another live cmd's hook, never into a file the user removed it from, never
   * from a development build (CoreOptions.autoHooks).
   */
  #autoHooks(): void {
    if (!this.#auto || !this.#hooks || this.#closed || !this.#core.settings.settings["agents.hooks.auto"]) return;
    const added: string[] = [];
    for (const t of this.targets()) {
      if (t.declined || (t.state !== "missing" && t.state !== "legacy" && t.state !== "stale")) continue;
      try {
        installHooks(t.agent, t.file, this.#hooks.script);
        log.info(`installed cmd's hook into ${t.file} (was ${t.state})`);
        if (!added.includes(t.title)) added.push(t.title);
      } catch (err) {
        log.error(`could not install cmd's hook into ${t.file}: ${(err as Error).message}`);
      }
    }
    if (added.length) {
      const names = added.length > 1 ? `${added.slice(0, -1).join(", ")} and ${added.at(-1)}` : added[0]!;
      this.#core.notifications.info(`${names} set up`, `${added.length > 1 ? "Their" : "Its"} state shows in cmd now. Change it in Settings → Agents.`);
    }
  }
}
