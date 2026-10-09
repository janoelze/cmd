// Workbench stories (pnpm workbench remote): the direct access setup checklist
// in Settings → Remote Access, in each state the Tailscale and "Your own URL"
// adapters report (their real strings), and the page as it looks before setup.
import type { ReactNode } from "react";
import type { RemoteAccessCheck } from "@cmd/protocol";
import { FormSection } from "@cmd/ui";
import { Setup, SetupWait, type ChecksState } from "./Remote.tsx";
import "./settings.css";

const DNS = "https://login.tailscale.com/admin/dns";
const HOST = "silverboi2.tail79ddb.ts.net";

const TITLES: [string, string][] = [
  ["installed", "Install Tailscale"],
  ["running", "Connect to your tailnet"],
  ["magicdns", "Turn on MagicDNS"],
  ["https", "Turn on HTTPS certificates"],
  ["published", "Publish on your tailnet"],
  ["reachable", "Test the address"],
];

/** The six Tailscale checks: ok up to the one given, then todo, as the adapter reports them. */
function tailscale(stopped?: Partial<RemoteAccessCheck> & { id: string }): RemoteAccessCheck[] {
  const at = stopped ? TITLES.findIndex(([id]) => id === stopped.id) : TITLES.length;
  return TITLES.map(([id, title], i) =>
    i < at ? { id, title, state: "ok", detail: OK_DETAIL[id] } : i === at ? { id, title, state: "todo", ...stopped } : { id, title, state: "todo" },
  );
}

const OK_DETAIL: Record<string, string | undefined> = {
  running: "lukas@github",
  magicdns: HOST,
  published: `https://${HOST}:8443 → 127.0.0.1:47391`,
  reachable: `https://${HOST}:8443`,
};

const noop = () => {};
const state = (checks: RemoteAccessCheck[] | null, o: Partial<ChecksState> = {}): ChecksState => ({ checks, error: null, busy: false, again: noop, ...o });

/** As wide as the Settings window's page. */
const Page = ({ children }: { children: ReactNode }) => <div className="sw-page">{children}</div>;

export const Checking = () => (
  <Page>
    <Setup title="Tailscale" {...state(null, { busy: true })} />
  </Page>
);

export const NotInstalled = () => (
  <Page>
    <Setup title="Tailscale" {...state(tailscale({ id: "installed", detail: "Get the Mac app from tailscale.com.", link: "https://tailscale.com/download/mac", linkLabel: "Download" }))} />
  </Page>
);

export const LoggedOut = () => (
  <Page>
    <Setup title="Tailscale" {...state(tailscale({ id: "running", detail: "Open Tailscale and log in." }))} />
  </Page>
);

export const HttpsOff = () => (
  <Page>
    <Setup
      title="Tailscale"
      {...state(tailscale({ id: "https", detail: "In Tailscale's admin console, under DNS. Your Mac's and tailnet's names then appear in public certificate logs.", link: DNS, linkLabel: "Open Admin Console" }))}
    />
  </Page>
);

export const PortTaken = () => (
  <Page>
    <Setup title="Tailscale" {...state(tailscale({ id: "published", state: "error", detail: "Port 8443 on your tailnet already serves something else. Pick another one (remote.tailscale.port)." }))} />
  </Page>
);

export const CheckingAgain = () => (
  <Page>
    <Setup title="Tailscale" {...state(tailscale({ id: "published", detail: "Not published yet.", action: "Publish" }), { busy: true })} />
  </Page>
);

export const Ready = () => (
  <Page>
    <Setup title="Tailscale" {...state(tailscale())} />
  </Page>
);

export const Unreachable = () => (
  <Page>
    <Setup
      title="Tailscale"
      {...state([
        ...tailscale().slice(0, 5),
        { id: "reachable", title: "Test the address", state: "error", detail: `Couldn't reach https://${HOST}:8443 (fetch failed). The first certificate can take a minute.` },
      ])}
    />
  </Page>
);

export const Failed = () => (
  <Page>
    <Setup title="Tailscale" {...state(null, { error: "the core isn't answering" })} />
  </Page>
);

export const OwnUrl = () => (
  <Page>
    <Setup
      title="Your Own URL"
      {...state([
        { id: "url", title: "Add an HTTPS address", state: "ok", detail: "https://mac.example.com" },
        { id: "page", title: "Forward the page", state: "error", detail: "Couldn't reach https://mac.example.com (getaddrinfo ENOTFOUND mac.example.com)." },
        { id: "socket", title: "Forward WebSockets", state: "todo" },
      ])}
    />
  </Page>
);

/** The page before setup: the code waits, the checklist right below. */
export const BeforeSetup = () => (
  <Page>
    <FormSection title="Pair a Device">
      <SetupWait />
    </FormSection>
    <Setup title="Tailscale" {...state(tailscale({ id: "https", detail: "In Tailscale's admin console, under DNS. Your Mac's and tailnet's names then appear in public certificate logs.", link: DNS, linkLabel: "Open Admin Console" }))} />
  </Page>
);
