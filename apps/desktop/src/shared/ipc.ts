// What main hands the app's pages through the preload (IPC), as types both sides
// share: main/ has the code that makes and uses them, the renderer only their shape,
// so it never imports from main/ (test/imports.test.ts).

import type { Keybindings } from "./commands.ts";

/** Who asked to open something: the person (a click, a drop) or a page's content (a link it made). */
export type OpenFrom = "user" | "content";

export interface KeybindingsSnapshot {
  bindings: Keybindings;
  errors: string[];
  path: string;
}

export interface OnboardingClaim {
  /** Step ids already shown on this Mac. */
  seen: string[];
  /** Nothing ran here before: every step shows, not only those for existing users. */
  newInstall: boolean;
}

export const FEEDBACK_KINDS = ["idea", "bug", "other"] as const;
export type FeedbackKind = (typeof FEEDBACK_KINDS)[number];

export interface FeedbackStatus {
  /** Feedback can be sent from this build. */
  available: boolean;
  /** Why not, when not. */
  reason: string | null;
}

export interface FeedbackRequest {
  kind: FeedbackKind;
  message: string;
  contact?: string;
  /** Attach version, platform… */
  includeInfo: boolean;
}

export interface AppProcess {
  pid: number;
  /** "Browser" (main), "GPU", "Tab" (a renderer), "Utility"… (Electron's ProcessMetric.type). */
  type: string;
  name: string;
  /** Percent of one core since the previous call. */
  cpu: number;
  /** Working set in bytes. */
  memory: number;
}

/** What a page in a browser window is asked about once per site, then remembered (main/web-policy.ts). */
export const ASKED = ["media", "geolocation", "notifications", "openExternal"] as const;
export type SitePermission = (typeof ASKED)[number];
/** Site (an http(s) origin) → its answers. */
export type SiteDecisions = Record<string, Partial<Record<SitePermission, boolean>>>;

/** What the sheet asks (preload: onSitePermission). */
export interface SitePermissionRequest {
  id: string;
  /** The site, e.g. "https://meet.google.com". */
  site: string;
  kind: SitePermission;
  /** media: which devices; openExternal: the app's name, if macOS knows it. */
  video?: boolean;
  audio?: boolean;
  app?: string;
}

export type MacDevice = "camera" | "microphone";

/**
 * A frame widget's page to serve (main/package-frames.ts): the package folder its files come
 * from, the hosts its grant reaches (media and images may load from them), and what the page
 * has before its first message: the theme's variables and appearance, the window's state and config.
 */
export interface PackageFrameRequest {
  /** The package folder (absolute); without one, `html` is the page (a Workbench story's). */
  dir?: string;
  /** The page: an .html file of the package, relative to it (view.html when left out). */
  page?: string;
  html?: string;
  media: string[];
  init: { appearance: "dark" | "light"; vars: Record<string, string>; state: Record<string, unknown>; config: Record<string, unknown>; placement?: "board" | "sidebar"; data?: unknown };
}
