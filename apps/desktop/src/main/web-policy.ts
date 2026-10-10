// What web pages in browser windows may do, as pure functions (main/web-session.ts
// applies them to the browser session; no Electron here, so they're unit-tested).
// Deny by default; a few harmless things every page gets; camera and microphone,
// location, notifications and opening other apps are asked once per site, and the
// answer is kept in site-permissions.json.

/** The session every browser window and the YouTube widget run in; no guest gets another. */
export const BROWSER_PARTITION = "persist:cmd-browser";

/** Granted to every page: video players, games and copy buttons expect them. */
const ALWAYS: ReadonlySet<string> = new Set(["fullscreen", "pointerLock", "clipboard-sanitized-write"]);

/** Asked once per site, then remembered. */
export const ASKED = ["media", "geolocation", "notifications", "openExternal"] as const;
export type SitePermission = (typeof ASKED)[number];
/** Site (an http(s) origin) → its answers. */
export type SiteDecisions = Record<string, Partial<Record<SitePermission, boolean>>>;

export const isAsked = (permission: string): permission is SitePermission => (ASKED as readonly string[]).includes(permission);

/** The site a decision is kept for: the URL's http(s) origin; any other page can't be asked for anything. */
export function siteOf(url: string | undefined): string | null {
  try {
    const u = new URL(url ?? "");
    return u.protocol === "http:" || u.protocol === "https:" ? u.origin : null;
  } catch {
    return null;
  }
}

/** allow and deny answer now; ask means the person decides (and the answer is kept). */
export type Verdict = "allow" | "deny" | "ask";

export function permissionVerdict(permission: string, site: string | null, decisions: SiteDecisions): Verdict {
  if (ALWAYS.has(permission)) return "allow";
  if (!isAsked(permission) || !site) return "deny";
  const kept = decisions[site]?.[permission];
  return kept === undefined ? "ask" : kept ? "allow" : "deny";
}

/** will-attach-webview: a guest in any other session (or none, the app's own) is refused. */
export const guestPartitionAllowed = (partition: string | undefined): boolean => partition === BROWSER_PARTITION;

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

/** site-permissions.json as read from disk: only well-formed entries survive. */
export function parseDecisions(json: unknown): SiteDecisions {
  const out: SiteDecisions = {};
  if (!json || typeof json !== "object") return out;
  for (const [site, answers] of Object.entries(json)) {
    if (siteOf(site) !== site || !answers || typeof answers !== "object") continue;
    const kept: Partial<Record<SitePermission, boolean>> = {};
    for (const [p, v] of Object.entries(answers)) if (isAsked(p) && typeof v === "boolean") kept[p] = v;
    if (Object.keys(kept).length) out[site] = kept;
  }
  return out;
}
