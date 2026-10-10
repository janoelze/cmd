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

/**
 * The answers without a site's answer to `kind`, or without all of its answers
 * (kind null): only ever removes. Throws on a site that isn't an http(s) origin
 * or a kind cmd doesn't ask for; the same object back when nothing was kept.
 */
export function forgetDecision(decisions: SiteDecisions, site: unknown, kind: unknown): SiteDecisions {
  if (typeof site !== "string" || siteOf(site) !== site) throw new Error("That isn't a website's address.");
  if (kind !== null && (typeof kind !== "string" || !isAsked(kind))) throw new Error("That isn't a permission sites are asked for.");
  const answers = decisions[site];
  if (!answers || (kind !== null && answers[kind] === undefined)) return decisions;
  const left = kind === null ? {} : Object.fromEntries(Object.entries(answers).filter(([k]) => k !== kind));
  const out: SiteDecisions = {};
  for (const [s, a] of Object.entries(decisions)) {
    if (s !== site) out[s] = a;
    else if (Object.keys(left).length) out[s] = left;
  }
  return out;
}

// ── macOS camera and microphone access ──────────────────
// cmd allowing a site the camera isn't enough: macOS asks once whether cmd may
// use it at all. Without that, a page waits forever for its stream.

/** A device macOS guards (systemPreferences.getMediaAccessStatus). */
export type MacDevice = "camera" | "microphone";
/** What macOS says about cmd and a device; "unknown" off macOS. */
export type MacAccess = "not-determined" | "granted" | "denied" | "restricted" | "unknown";

/** The devices a media request wants (Electron's mediaTypes: "video", "audio"). */
export function macDevices(mediaTypes: readonly string[] | undefined): MacDevice[] {
  const t = mediaTypes ?? [];
  return [...(t.includes("video") ? (["camera"] as const) : []), ...(t.includes("audio") ? (["microphone"] as const) : [])];
}

/**
 * The answer to a media request, given cmd's own (allowed: the site's kept or
 * just given answer) and what macOS says per device: deny (cmd said no), allow
 * (macOS has given every device), ask (macOS hasn't decided: show its prompt for
 * these, then allow only if it gives them all), or tell (macOS refused: answer
 * no and say where to turn it on).
 */
export type MacMediaStep = { kind: "deny" } | { kind: "allow" } | { kind: "ask"; devices: MacDevice[] } | { kind: "tell"; devices: MacDevice[] };

export function macMediaStep(allowed: boolean, devices: readonly MacDevice[], access: (d: MacDevice) => MacAccess): MacMediaStep {
  if (!allowed) return { kind: "deny" };
  const state = devices.map((d) => [d, access(d)] as const);
  const refused = state.filter(([, a]) => a === "denied" || a === "restricted").map(([d]) => d);
  if (refused.length) return { kind: "tell", devices: refused };
  const undecided = state.filter(([, a]) => a === "not-determined").map(([d]) => d);
  return undecided.length ? { kind: "ask", devices: undecided } : { kind: "allow" };
}

/** System Settings → Privacy & Security at the device's list. */
export const macPrivacyPane = (d: MacDevice): string => `x-apple.systempreferences:com.apple.preference.security?${d === "camera" ? "Privacy_Camera" : "Privacy_Microphone"}`;
