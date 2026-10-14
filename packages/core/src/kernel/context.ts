// What the core's services and features get from each other (docs/architecture-review-01/03,
// AR1-03-02): the shared services by name, plus the few things only Core does (send an event
// to clients, place a call in a workspace, count an opened window). A service's wiring takes
// the slice it needs, Pick<CoreContext, "ai" | "agents">, so its dependencies are in its
// signature, not in closures back into Core. Each service lives where Core keeps it; reading
// one before Core made it throws, so construction order can't go wrong quietly.

import type { AgentId, AppWindow, CoreEvent, Method, Params, Placement, Result, Workspace } from "@cmd/protocol";
import type { Connection, Served } from "./connection.ts";
import type { ActionsService } from "../actions/service.ts";
import type { AgentTracker } from "../agents/tracker.ts";
import type { AgentHomes } from "../agents/homes.ts";
import type { AgentNaming } from "../agents/naming.ts";
import type { AiService } from "../ai/service.ts";
import type { DataService } from "../data/service.ts";
import type { SessionsView } from "../data/views/sessions.ts";
import type { ViewsStore } from "../data/views/views.ts";
import type { JournalService } from "../journal/service.ts";
import type { MagicPackages } from "../magic/package/service.ts";
import type { NotificationCenter } from "../notifications/center.ts";
import type { TranscriptSources } from "../search/sources.ts";
import type { SummaryService } from "../summaries/service.ts";
import type { PaneManager } from "../terminals/panes.ts";
import type { CommandLog } from "../terminals/commands.ts";
import type { ClosedWindows, WindowManager, WindowTypes } from "../windows/index.ts";
import type { TimerAlarms } from "../windows/timers.ts";
import type { WorkspaceManager } from "../workspaces/manager.ts";
import type { WidgetTokens } from "../data/widgets.ts";
import type { PreviewBroker } from "../magic/previews.ts";
import type { WidgetLibrary } from "../widgets/library.ts";
import type { AgentSetup } from "../agents/setup.ts";
import type { Search } from "../search/search.ts";
import type { Subscriptions } from "../data/subscriptions.ts";
import type { WindowOps } from "../windows/ops.ts";
import type { RemoteService } from "../remote/service.ts";
import type { ProcessSampler, ResourceMonitor } from "../terminals/resources.ts";
import type { WatchService } from "../lib/watch.ts";
import type { SqliteService } from "../sqlite/service.ts";
import type { StatsService } from "../stats/service.ts";
import type { CoreServer } from "./server.ts";
import type { Scheduler } from "./scheduler.ts";
import type { SecretsService } from "./secrets.ts";
import type { SettingsService } from "./settings.ts";
import type { Store } from "./store.ts";
import type { UsageStats } from "./usage.ts";

/** The services, by the names Core keeps them under. */
export interface Services {
  settings: SettingsService;
  store: Store;
  scheduler: Scheduler;
  data: DataService;
  views: ViewsStore;
  sessions: SessionsView;
  usage: UsageStats;
  secrets: SecretsService;
  ai: AiService;
  panes: PaneManager;
  commands: CommandLog;
  agents: AgentTracker;
  homes: AgentHomes;
  naming: AgentNaming;
  transcripts: TranscriptSources;
  notifications: NotificationCenter;
  workspaces: WorkspaceManager;
  windowTypes: WindowTypes;
  windows: WindowManager;
  closed: ClosedWindows;
  timers: TimerAlarms;
  summaries: SummaryService;
  journal: JournalService;
  magic: MagicPackages;
  actions: ActionsService;
  widgetTokens: WidgetTokens;
  server: CoreServer;
  subscriptions: Subscriptions;
  agentSetup: AgentSetup;
  search: Search;
  library: WidgetLibrary;
  previews: PreviewBroker;
  windowOps: WindowOps;
  remote: RemoteService;
  resources: ResourceMonitor | null;
  processes: ProcessSampler | null;
  watches: WatchService;
  sqlite: SqliteService;
  stats: StatsService;
}

/** What only Core does. */
export interface CoreActions {
  /** An event to every subscribed client that wants it. */
  broadcast(event: CoreEvent): void;
  /** The workspace a call is about: the one asked for, the caller's, a parent agent's, else by path. */
  place(p: Placement, o?: { parentId?: AgentId | null; path?: string }): Workspace;
  /** A window just opened: counted, and the Widget Library told. */
  opened<W extends AppWindow | null>(w: W): W;
  /** Whether any client is subscribed (what nobody can see can wait). */
  watched(): boolean;
  /** Answers JSON-RPC on a connection: the socket's, or a paired device's session. */
  serve(conn: Connection): Served;
  /** A method, as a caller inside the core calls it (Core.call): for features that act through the API, like the tools (tools/). */
  call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>>;
}

export type CoreContext = Services & CoreActions;

const SERVICES: (keyof Services)[] = ["settings", "store", "scheduler", "data", "views", "sessions", "usage", "secrets", "ai", "panes", "commands", "agents", "homes", "naming", "transcripts", "notifications", "workspaces", "windowTypes", "windows", "closed", "timers", "summaries", "journal", "magic", "actions", "widgetTokens", "server", "subscriptions", "agentSetup", "search", "library", "previews", "windowOps", "remote", "resources", "processes", "watches", "sqlite", "stats"];

/** The context over `owner`'s services (read when used, so a service may take the context before the ones it calls exist). */
export function contextOf(owner: Partial<Services>, actions: CoreActions): CoreContext {
  const ctx = { ...actions } as CoreContext;
  for (const key of SERVICES)
    Object.defineProperty(ctx, key, {
      enumerable: true,
      get: () => {
        const s = owner[key];
        if (s === undefined) throw new Error(`core.${key} was used before the core made it`);
        return s;
      },
    });
  return ctx;
}
