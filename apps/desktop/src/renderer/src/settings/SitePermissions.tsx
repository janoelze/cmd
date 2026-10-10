// Settings → Browser: what websites in browser windows were allowed or refused
// (the answers from SitePermissionSheet, kept in site-permissions.json by
// main/web-session.ts), one section per site, each answer removable, or all of a
// site's at once. A removed answer is asked again on the site's next request;
// nothing needs a restart. Looks again when a sheet is answered and whenever the
// window gets focus (an edited file).

import { useEffect, useState } from "react";
import { Button, Callout, EmptyState, FormActions, FormRow, FormSection, LinkButton } from "@cmd/ui";
import { ASKED, type SiteDecisions, type SitePermission } from "../../../main/web-policy.ts";
import { cmd } from "../bridge.ts";

const NAMES: Record<SitePermission, string> = {
  media: "Camera and microphone",
  geolocation: "Location",
  notifications: "Notifications",
  openExternal: "Opening other apps",
};

/** Words a settings search finds this page by. */
export const SITE_PERMISSION_WORDS = ["browser", "site", "website", "permission", "camera", "microphone", "location", ...Object.values(NAMES).map((n) => n.toLowerCase())];

/** The site as people know it: its host, with the port when it has one. */
const host = (site: string) => {
  try {
    return new URL(site).host;
  } catch {
    return site;
  }
};

/** An error from main without Electron's "Error invoking remote method …" prefix. */
const ipcMessage = (e: Error) => e.message.replace(/^Error invoking remote method '[^']+': (Error: )?/, "");

export function SitePermissions() {
  const [kept, setKept] = useState<SiteDecisions | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    const look = () => void cmd.sitePermissions().then(setKept, (e: Error) => setError(ipcMessage(e)));
    look();
    const off = cmd.onSitePermissionsChanged(look);
    window.addEventListener("focus", look);
    return () => (off(), window.removeEventListener("focus", look));
  }, []);
  if (!kept) return error ? <EmptyState icon="exclamationmark.triangle" title="Couldn't read site permissions">{error}</EmptyState> : null;

  const forget = (site: string, kind: SitePermission | null) =>
    void cmd.forgetSitePermission(site, kind).then((k) => (setKept(k), setError(null)), (e: Error) => setError(ipcMessage(e)));
  const sites = Object.keys(kept).sort((a, b) => host(a).localeCompare(host(b)));

  const failed = error && <Callout tone="danger">{error}</Callout>;
  if (!sites.length)
    return (
      <>
        {failed}
        <EmptyState icon="hand.raised" title="No site permissions yet">
          When a website asks for your camera, location or notifications, your answer shows here.
        </EmptyState>
      </>
    );
  return (
    <>
      {failed}
      {sites.map((site) => {
        const answers = ASKED.filter((k) => kept[site]![k] !== undefined);
        return (
          <FormSection
            key={site}
            title={<span data-tip={site}>{host(site)}</span>}
            aside={answers.length > 1 && <LinkButton aria-label={`Remove All for ${host(site)}`} onClick={() => forget(site, null)}>Remove All</LinkButton>}
          >
            {answers.map((k) => (
              <FormRow key={k} compact title={NAMES[k]} description={kept[site]![k] ? "Allowed" : "Not allowed"}>
                <Button size="sm" aria-label={`Remove ${NAMES[k]} for ${host(site)}`} onClick={() => forget(site, k)}>
                  Remove
                </Button>
              </FormRow>
            ))}
          </FormSection>
        );
      })}
      <FormActions hint="A site asks again for anything you remove.">{null}</FormActions>
    </>
  );
}
