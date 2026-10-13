// A page in one of this window's browser windows asks for a permission (main/web-session.ts):
// the approval sheet (docs/55), the site in its title bar, "Use your camera and microphone".
// Allow and Don't Allow are kept for the site; Esc or the close button answers no for now and
// asks again next time. One sheet at a time, oldest first.

import { ApprovalSheet, usePresentValue } from "@cmd/ui";
import { useEffect, useState } from "react";
import type { SitePermissionRequest } from "../../../shared/ipc.ts";
import { cmd } from "../lib/bridge.ts";

/** What the page wants to do, after "to". */
export function permissionAsk(r: Pick<SitePermissionRequest, "kind" | "video" | "audio" | "app">): string {
  switch (r.kind) {
    case "media":
      return r.video && r.audio ? "use your camera and microphone" : r.video ? "use your camera" : r.audio ? "use your microphone" : "use your camera or microphone";
    case "geolocation":
      return "know your location";
    case "notifications":
      return "show notifications";
    case "openExternal":
      return r.app ? `open ${r.app}` : "open another app";
  }
}

/** The site as people know it: its host, with the port when it has one. */
const siteName = (site: string) => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};

export function SitePermissionSheet() {
  const [queue, setQueue] = useState<SitePermissionRequest[]>([]);
  useEffect(
    () =>
      cmd.onSitePermission(
        (r) => setQueue((q) => [...q, r]),
        (id) => setQueue((q) => q.filter((r) => r.id !== id)),
      ),
    [],
  );
  // The answered one stays while it fades out; the next one takes its place.
  const shown = usePresentValue(queue[0], !!queue[0]);
  const r = shown.value;
  if (!r) return null;
  const answer = (allow: boolean | null) => {
    cmd.answerSitePermission(r.id, allow);
    setQueue((q) => q.filter((x) => x.id !== r.id));
  };
  const ask = permissionAsk(r);
  return (
    <ApprovalSheet
      key={r.id}
      open={!shown.closing}
      who={{ icon: "globe", name: siteName(r.site), context: "a page in a browser window" }}
      title={ask[0]!.toUpperCase() + ask.slice(1)}
      why="cmd remembers your answer for this site."
      deny="Don't Allow"
      askWhy={false}
      className="site-permission"
      onAnswer={(a) => answer(a.allow)}
      onDismiss={() => answer(null)}
    />
  );
}
