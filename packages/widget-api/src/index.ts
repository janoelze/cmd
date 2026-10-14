// @cmd/widget-api, API 1 (docs/56-widgets-v3.md): what a cmd widget is written against.
// A widget is a React component made of these elements, reading cmd through the hooks
// and the `cmd` object; it runs in its own process and the app draws it with its kit.
//
//   import { defineWidget, View, List, ListRow, ListRowContent, useAgents, cmd } from "@cmd/widget-api";
//   export default defineWidget(() => {
//     const agents = useAgents();
//     return <View><List>{agents.map((a) => <ListRow key={a.id} onClick={() => cmd.windows.select(a.windowId!)}><ListRowContent title={a.name} /></ListRow>)}</List></View>;
//   });
//
// Within API 1 nothing here changes or goes; additions carry `@since 1.x`.

import { createElement, type ReactNode } from "react";
import { useConfig, type ConfigShape, type ConfigValues } from "./hooks.ts";

export * from "./elements.ts";
export { cmd } from "./cmd.ts";
export { fmt } from "./fmt.ts";
export { ApiCallError } from "./connection.ts";
export { useWorkspace, useAgents, useTerminals, useWindows, useEvents, useGit, useActions, useConfig, useEnv, type WidgetConfig, type ConfigValues, type ConfigShape, useData, useStoredState, useNow, useCompletion, type DataState, type CompletionState } from "./hooks.ts";
export { WIDGET_API, WIDGET_API_MINOR } from "./version.ts";
export type {
  ApiAgent as Agent,
  ApiAgentState as AgentState,
  ApiTerminal as Terminal,
  ApiTerminalScreen as TerminalScreen,
  ApiWindow as WindowInfo,
  ApiWorkspace as Workspace,
  ApiEvent as Event,
  ApiEventQuery as EventQuery,
  ApiEventStats as EventStats,
  ApiGitStatus as GitStatus,
  ApiGitWorktree as GitWorktree,
  ApiAction as WorkspaceAction,
  ApiNotification as Notification,
  ApiScopeQuery as ScopeQuery,
  ApiFetchInit as FetchInit,
  ApiFetchResponse as FetchResponse,
  ApiAgentStart as AgentStart,
  ApiStarted as StartedAgent,
  ApiTerminalOpen as TerminalOpen,
  ApiActionStarted as ActionStarted,
  ApiRunOptions as RunOptions,
  ApiRunResult as RunResult,
  ApiCompletionRequest as CompletionRequest,
  ApiCompletion as Completion,
  WidgetEnv as Env,
  ApiVerb as Verb,
} from "@cmd/protocol/widget-tree";

/** A widget: a component with no props, the module's default export. @since 1.0 */
export type Widget = () => ReactNode;

/**
 * Declares a widget: `render` is its view, called with this window's config (live).
 * The module's default export is what cmd runs; a plain component works too.
 *
 *   export default defineWidget<{ repo: string }>(({ config }) => <Text>{config.repo}</Text>);
 *
 * @since 1.0
 */
export function defineWidget<Config extends ConfigShape<Config> = ConfigValues>(render: (props: { config: Config }) => ReactNode): Widget {
  function Widget(): ReactNode {
    return createElement(render as (p: { config: Config }) => ReactNode, { config: useConfig<Config>() });
  }
  Object.defineProperty(Widget, "name", { value: render.name || "Widget" });
  return Widget;
}
