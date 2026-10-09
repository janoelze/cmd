// Built-in window views. Each uses the same registration a plugin would.

import { ACTIONS_TITLE, type AppWindow } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import type { MenuEntry } from "../context.ts";
import { copy } from "../actions.ts";
import { hostOf, shortPath } from "../model.ts";
import { windowActions } from "../windowActions.ts";
import { BrowserView } from "../components/BrowserView.tsx";
import { DEVICES } from "../devices.ts";
import { FilesView } from "../components/FilesView.tsx";
import { MagicView, setEditing } from "../components/MagicView.tsx";
import { AgentActivity } from "../components/AgentActivity.tsx";
import { LiveDiff } from "../components/LiveDiff.tsx";
import { watchUrl, YouTubeView } from "../components/YouTubeView.tsx";
import { NavigatorView } from "../components/Navigator.tsx";
import { CommandsView } from "../components/CommandsView.tsx";
import { ActionsView } from "../components/ActionsView.tsx";
import { actionsRootOf, lastLists } from "../workspaceActions.ts";
import { getState } from "../store.ts";
import { JournalView } from "../components/JournalView.tsx";
import { NotificationsView } from "../components/NotificationsView.tsx";
import { ResourcesView } from "../components/ResourcesView.tsx";
import { TimerView } from "../components/TimerView.tsx";
import { clearEventStream, eventClasses, EventsView } from "../components/EventsView.tsx";
import { scopeMenu, scopeOf, setWidgetState } from "../widgets.ts";
import { intervalLabel, refreshChoices } from "../magic.ts";
import { lazyView, registerWindowView, stateStr } from "./registry.ts";
import "./markdown.tsx"; // registers the "markdown" view
import "./json.tsx"; // registers the "json" view
import "./sqlite.tsx"; // registers the "sqlite" view
import "./visualizer.tsx"; // registers the "visualizer" view
import "./image.tsx"; // registers the "image" view
import "./jam.tsx"; // registers the "jam" view
import { previewFor, togglePreview } from "./preview.ts";

/** Right-click → Device Size: show the page at a phone's, tablet's or desktop's size. */
function deviceMenu(w: AppWindow): MenuEntry {
  const current = stateStr(w, "device");
  const pick = (device: string | null) => () => void cmd.call("window.update", { id: w.id, state: { device } }).catch(() => {});
  return {
    label: "Device Size",
    submenu: [
      { label: "Fit Window", checked: !current, run: pick(null) },
      ...DEVICES.flatMap((group): MenuEntry[] => [
        "-",
        ...group.map((d) => ({ label: `${d.name}  ${d.width}×${d.height}`, checked: current === d.id, run: pick(d.id) })),
      ]),
    ],
  };
}

const parentOf = (p: string) => shortPath(p.split("/").slice(0, -1).join("/") || "/");

registerWindowView({
  kind: "browser",
  View: BrowserView,
  placeInToolbar: true,
  describe: (w) => {
    const url = stateStr(w, "url") ?? null;
    const host = hostOf(url).replace(/^www\./, "");
    return { name: (w.title && w.title !== url ? w.title : host) || "New Tab", place: host };
  },
  menu: (w) => {
    const url = stateStr(w, "url");
    return [
      deviceMenu(w),
      ...(url
        ? [
            "-" as const,
            { label: "Open in Default Browser", run: () => cmd.openPath(url) },
            { label: "Copy URL", run: () => copy(url) },
          ]
        : []),
    ];
  },
});

registerWindowView({
  kind: "files",
  View: FilesView,
  placeInToolbar: true,
  describe: (w) => ({ place: parentOf(stateStr(w, "path") ?? "/") }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return p
      ? [
          { label: "Show in Finder", run: () => cmd.openPath(p) },
          { label: "Copy Path", run: () => copy(p) },
        ]
      : [];
  },
});

registerWindowView({
  kind: "pdf",
  // pdf.js loads on first use, not at startup.
  View: lazyView(() => import("../components/PdfView.tsx").then((m) => m.PdfView)),
  describe: (w) => ({ place: stateStr(w, "path") ? parentOf(stateStr(w, "path")!) : undefined }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return [
      { label: "Dark Pages", checked: w.state.dark === true, run: () => void cmd.call("window.update", { id: w.id, state: { dark: w.state.dark !== true } }).catch(() => {}) },
      "-" as const,
      ...(p
        ? [
            { label: "Open with Default App", run: () => cmd.openPath(p) },
            { label: "Show in Finder", run: () => cmd.revealPath(p) },
            { label: "Copy Path", run: () => copy(p) },
          ]
        : []),
    ];
  },
});

registerWindowView({
  kind: "text",
  // CodeMirror loads on first use, not at startup.
  View: lazyView(() => import("../components/TextView.tsx").then((m) => m.TextView)),
  describe: (w) => ({ place: stateStr(w, "path") ? parentOf(stateStr(w, "path")!) : undefined }),
  menu: (w) => {
    const p = stateStr(w, "path");
    return p
      ? [
          ...(previewFor(p) ? [{ label: "Preview (⌘E)", run: () => togglePreview(w) }] : []),
          { label: "Open with Default App", run: () => cmd.openPath(p) },
          { label: "Copy Path", run: () => copy(p) },
        ]
      : [];
  },
});

/** Refresh Every ▸: the widget's interval, chosen by the model until the person picks one. */
function refreshEvery(w: AppWindow): MenuEntry {
  const cur = typeof w.state.refresh === "number" ? w.state.refresh : 0;
  // The model's own interval (e.g. 3 s) is listed too, so it shows as checked.
  const choices = refreshChoices(cur);
  return {
    label: "Refresh Every",
    submenu: choices.map((s) => ({
      label: intervalLabel(s),
      checked: s === cur,
      run: () => void cmd.call("magic.setRefresh", { id: w.id, seconds: s }),
    })),
  };
}

registerWindowView({
  kind: "magic",
  View: MagicView,
  describe: (w) => {
    const src = w.state.source as { type?: string; url?: string; command?: string } | null | undefined;
    const place = src?.type === "fetch" ? hostOf(src.url ?? "").replace(/^www\./, "") : src?.type === "command" ? (src.command ?? "").split(/\s+/)[0] : undefined;
    // No "magic" kind label: the sparkle icon says it, and title bars are short on room.
    // "Magic" is the placeholder title of widgets made before the rename.
    const placeholder = w.title === "Magic Widget" || w.title === "Magic";
    // The icon the build picked (manifest.json), else the type's sparkles.
    return { name: placeholder ? stateStr(w, "prompt") || "New Widget" : w.title, place, kind: null, icon: stateStr(w, "icon") };
  },
  // Change, Refresh and Stop have no buttons on the window (nothing covers a
  // widget): they are here, on right-click in the widget or its title bar, and
  // in the View menu (⌘L, ⌘R, ⌘.). All go through MagicView's window actions.
  actions: (w) => {
    const phase = stateStr(w, "phase");
    const a = () => windowActions(w.id);
    const hasData = !!(w.state.source || w.state.hasData);
    const health = w.state.health as { ok?: boolean } | undefined;
    const problems = Array.isArray(w.state.problems) && w.state.problems.length > 0;
    if (phase === "working") return [{ label: "Stop", run: () => a()?.stop?.() }, { label: "Edit Widget (⌘E)", run: () => setEditing(w.id, true) }];
    return [
      ...(phase === "ready" || stateStr(w, "html") ? [{ label: "Change…", run: () => a()?.change?.() }] : []),
      ...(phase !== "empty" ? [{ label: "Edit Widget (⌘E)", run: () => setEditing(w.id, true) }] : []),
      ...(hasData ? [{ label: "Refresh Now", run: () => a()?.refresh?.() }, refreshEvery(w)] : []),
      ...(w.state.widgetId && hasData ? [{ label: "Mute Notifications", checked: !!w.state.muted, run: () => void cmd.call("magic.mute", { id: w.id, muted: !w.state.muted }) }] : []),
      ...((health && health.ok === false) || problems || w.state.error ? [{ label: "Fix It", run: () => void cmd.call("magic.fix", { id: w.id }) }] : []),
    ];
  },
  menu: (w) => {
    const prompt = stateStr(w, "prompt");
    return [
      ...(prompt ? [{ label: "Copy Request", run: () => copy(prompt) }] : []),
      ...(stateStr(w, "html") ? [{ label: "Copy Widget HTML", run: () => copy(stateStr(w, "html")!) }] : []),
    ];
  },
});

// Built-in widgets (docs/16-widgets.md).
registerWindowView({
  kind: "agents",
  View: AgentActivity,
  describe: () => ({ kind: null }),
  titleMenu: (w) => ({ label: scopeLabel(w), entries: scopeMenu(w.id, scopeOf(w.state.scope)) }),
  menu: (w) => scopeMenu(w.id, scopeOf(w.state.scope)),
});

registerWindowView({
  kind: "diff",
  View: LiveDiff,
  describe: (w) => ({ place: shortPath(stateStr(w, "path") ?? ""), kind: null }),
  menu: (w) => [
    {
      label: "Choose Folder…",
      run: () =>
        void cmd.chooseFolder().then((p) => {
          if (p) void cmd.call("window.update", { id: w.id, state: { path: p } }).catch(() => {});
        }),
    },
    { label: "Show in Finder", run: () => cmd.revealPath(stateStr(w, "path") ?? "") },
  ],
});

registerWindowView({
  kind: "youtube",
  View: YouTubeView,
  describe: () => ({ kind: null }),
  menu: (w) => {
    const url = watchUrl({ video: stateStr(w, "video"), list: stateStr(w, "list"), start: typeof w.state.start === "number" ? w.state.start : undefined });
    return url
      ? [
          { label: "Change Video…", run: () => void cmd.call("window.update", { id: w.id, title: "YouTube", state: { input: null } }).catch(() => {}) },
          { label: "Fill Window", checked: w.state.fill !== false, run: () => void cmd.call("window.update", { id: w.id, state: { fill: w.state.fill === false } }).catch(() => {}) },
          "-" as const,
          { label: "Open on YouTube", run: () => cmd.openPath(url) },
          { label: "Copy Link", run: () => copy(url) },
        ]
      : [];
  },
});

registerWindowView({
  kind: "navigator",
  View: NavigatorView,
  describe: () => ({ kind: null }),
});

// List widgets: the title bar's menu (titleMenu) switches their scope and has their
// options; the same entries are on right-click. Their summary is the title bar's status.
const scopeLabel = (w: AppWindow) => (scopeOf(w.state.scope) === "all" ? "All Spaces" : "This Space");
const scoped = (extra: (w: AppWindow) => MenuEntry[]) => (w: AppWindow) => [...scopeMenu(w.id, scopeOf(w.state.scope)), "-" as const, ...extra(w)];
const commandsMenu = scoped((w) => [{ label: "Failed Only", checked: w.state.failedOnly === true, run: () => setWidgetState(w.id, { failedOnly: w.state.failedOnly !== true }) }]);
const notificationsMenu = scoped(() => [{ label: "Clear Notifications", run: () => void cmd.call("notify.clear", {}).catch(() => {}) }]);
const journalMenu = (w: AppWindow) => scopeMenu(w.id, scopeOf(w.state.scope));
const resourcesMenu = scoped(() => [{ label: "Open Task Manager", run: () => cmd.openTaskManager() }]);

registerWindowView({
  kind: "commands",
  View: CommandsView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => ({ label: scopeLabel(w), entries: commandsMenu(w) }),
  menu: commandsMenu,
});

// Workspace Actions: the title bar names the folder (or worktree) they're for; its
// menu follows the selected terminal's checkout or picks one of the repository's.
const actionsMenu = (w: AppWindow): MenuEntry[] => {
  const settings = getState().settings.settings;
  const set = (key: "actions.describe" | "actions.openBrowser", value: boolean) => void cmd.call("settings.set", { key, value }).catch(() => {});
  const root = actionsRootOf(w);
  const pinned = typeof w.state.path === "string";
  const follow = !pinned && w.state.follow !== false;
  const trees = lastLists.get(w.id)?.worktrees ?? [];
  return [
    { label: "Follow Selected Terminal", checked: follow, run: () => setWidgetState(w.id, { path: null, follow: true }) },
    ...(trees.length > 1
      ? [
          "-" as const,
          ...trees.map((t) => ({
            label: `${t.branch ?? shortPath(t.top)}${t.running ? ` · ${t.running} running` : ""}${t.agents ? ` · ${t.agents} ${t.agents === 1 ? "agent" : "agents"}` : ""}`,
            checked: !follow && t.top === root,
            run: () => setWidgetState(w.id, { path: t.top }),
          })),
        ]
      : []),
    { label: "Use the Space's Folder", checked: !pinned && !follow, run: () => setWidgetState(w.id, { path: null, follow: false }) },
    "-",
    { label: "Describe with AI", checked: settings["actions.describe"], run: () => set("actions.describe", !settings["actions.describe"]) },
    { label: "Open Dev Servers in a Browser", checked: settings["actions.openBrowser"], run: () => set("actions.openBrowser", !settings["actions.openBrowser"]) },
  ];
};

registerWindowView({
  kind: "actions",
  View: ActionsView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => {
    const root = actionsRootOf(w);
    const branch = lastLists.get(w.id)?.checkout;
    const name = root ? root.replace(/\/+$/, "").split("/").pop() || root : ACTIONS_TITLE;
    return { label: branch?.linked && branch.branch ? `${name} · ${branch.branch}` : name, entries: actionsMenu(w) };
  },
  menu: actionsMenu,
});

registerWindowView({
  kind: "journal",
  View: JournalView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => ({ label: scopeLabel(w), entries: journalMenu(w) }),
  menu: journalMenu,
});

registerWindowView({
  kind: "notifications",
  View: NotificationsView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => ({ label: scopeLabel(w), entries: notificationsMenu(w) }),
  menu: notificationsMenu,
});

registerWindowView({
  kind: "resources",
  View: ResourcesView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => ({ label: scopeLabel(w), entries: resourcesMenu(w) }),
  menu: resourcesMenu,
});

// Event Stream: pause, clear, and which classes of events show (the core's classes, data.explain).
const eventsMenu = (w: AppWindow): MenuEntry[] => {
  const hidden = Array.isArray(w.state.hidden) ? (w.state.hidden as string[]) : [];
  const paused = w.state.paused === true;
  return [
    { label: paused ? "Resume" : "Pause", run: () => setWidgetState(w.id, { paused: !paused }) },
    { label: "Clear", run: () => clearEventStream(w.id) },
    "-",
    ...eventClasses().map(({ class: c, title }) => ({
      label: title,
      checked: !hidden.includes(c),
      run: () => setWidgetState(w.id, { hidden: hidden.includes(c) ? hidden.filter((x) => x !== c) : [...hidden, c] }),
    })),
    { label: "Show All", enabled: hidden.length > 0, run: () => setWidgetState(w.id, { hidden: [] }) },
  ];
};

registerWindowView({
  kind: "events",
  View: EventsView,
  describe: () => ({ kind: null }),
  titleMenu: (w) => {
    const hidden = Array.isArray(w.state.hidden) ? w.state.hidden.length : 0;
    return { label: hidden ? `${hidden} hidden` : "All Events", entries: eventsMenu(w) };
  },
  menu: eventsMenu,
});

registerWindowView({
  kind: "timer",
  View: TimerView,
  describe: () => ({ kind: null }),
  menu: (w) => [
    { label: w.state.endsAt ? "Pause" : "Start", run: () => setWidgetState(w.id, { action: w.state.endsAt ? "pause" : "start" }) },
    { label: "Reset", run: () => setWidgetState(w.id, { action: "reset" }) },
  ],
});
