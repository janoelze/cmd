// What the updater (updater.ts) decides, without Electron, so tests can hold it: which
// versions are pulled (updates/blocked-versions.json on master, which installed apps read
// before every check, so a bad release stops spreading with a push and no new release),
// and whether a version found replaces the one already downloaded.

/** The blocklist installed apps read. Raw GitHub caches it for up to 5 minutes. */
export const BLOCKLIST_URL = "https://raw.githubusercontent.com/janoelze/cmd/master/updates/blocked-versions.json";

/** Pulled versions and why, from the blocklist's JSON; anything malformed counts as no entry. */
export function parseBlocklist(text: string): Map<string, string> {
  const blocked = new Map<string, string>();
  try {
    const versions = (JSON.parse(text) as { versions?: unknown }).versions;
    if (versions && typeof versions === "object")
      for (const [version, why] of Object.entries(versions)) if (VERSION.test(version)) blocked.set(version, typeof why === "string" ? why : "");
  } catch {}
  return blocked;
}

const VERSION = /^\d+\.\d+\.\d+(-[\w.]+)?$/;

/** a > b for release versions (x.y.z; one with a prerelease suffix sorts before its release). */
export function isNewer(a: string, b: string): boolean {
  const parse = (v: string) => {
    const dash = v.indexOf("-");
    return { nums: (dash < 0 ? v : v.slice(0, dash)).split(".").map(Number), pre: dash < 0 ? null : v.slice(dash + 1) };
  };
  const [pa, pb] = [parse(a), parse(b)];
  for (let i = 0; i < 3; i++) if (pa.nums[i] !== pb.nums[i]) return (pa.nums[i] ?? 0) > (pb.nums[i] ?? 0);
  if (pa.pre === pb.pre) return false;
  if (pa.pre === null) return true;
  if (pb.pre === null) return false;
  return pa.pre > pb.pre;
}

/**
 * A version a check found, against the newest one already downloaded or on its way (null:
 * none): fetch it, or keep what there is. A check finds the release that is latest now,
 * so a newer one replaces a download that waits for a restart instead of being ignored
 * until then (a downloaded update used to stop all checks).
 */
export function onFound(found: string, have: string | null): "download" | "keep" {
  return have === null || isNewer(found, have) ? "download" : "keep";
}

/** An updater error as one short line for Settings and the dialog: electron-updater's
 *  messages carry stacks and whole release feeds (update.log keeps them in full). */
export function describeUpdateError(message: string): string {
  if (/net::ERR_|ENOTFOUND|EAI_AGAIN|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENETUNREACH|socket hang up/.test(message))
    return "Couldn't reach GitHub. cmd tries again shortly.";
  if (/rate limit|\b(403|429)\b/i.test(message)) return "GitHub is limiting requests. cmd tries again shortly.";
  const line = (message.split(/\r?\n|, XML:|\s+at\s/)[0] ?? "").trim();
  return line.length > 160 ? `${line.slice(0, 159)}…` : line || "Unknown error.";
}
