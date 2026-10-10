// "Allow “meet.google.com” to use your camera and microphone?": a page in one of
// this window's browser windows asks for a permission (main/web-session.ts).
// Allow and Don't Allow are kept for the site; Esc or the close button answers
// no for now and asks again next time. One sheet at a time, oldest first.

import { Button, Dialog } from "@cmd/ui";
import { useEffect, useState } from "react";
import type { SitePermissionRequest } from "../../../main/web-policy.ts";
import { cmd } from "../bridge.ts";

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
  const r = queue[0];
  if (!r) return null;
  const answer = (allow: boolean | null) => {
    cmd.answerSitePermission(r.id, allow);
    setQueue((q) => q.filter((x) => x.id !== r.id));
  };
  return (
    <Dialog
      key={r.id}
      open
      onClose={() => answer(null)}
      title={`Allow “${siteName(r.site)}” to ${permissionAsk(r)}?`}
      width={400}
      position="center"
      className="site-permission"
      actions={
        <>
          <Button onClick={() => answer(false)}>Don't Allow</Button>
          <Button variant="primary" onClick={() => answer(true)}>
            Allow
          </Button>
        </>
      }
    >
      cmd remembers your answer for this site.
    </Dialog>
  );
}
