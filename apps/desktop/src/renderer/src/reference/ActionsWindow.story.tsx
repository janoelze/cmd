// Reference window, actions: a list of things to
// run, grouped, the main one first with its own Run button, running and failed
// ones marked, the filter in the toolbar and where they run in the footer. The
// spec for Workspace Actions, Commands and any list you act on.

import { Button, Icon, IconButton, LinkButton, List, ListGroup, ListRow, ListRowActions, ListRowContent, ListRowEnd, ListRowIcon, ListSection, ListValue, Spinner, StatusLine, ToolbarButton, ToolbarSearchField, ToolbarSpacer, View, type ViewStateSpec, WindowToolbar, type IconName } from "@cmd/ui";
import { useState } from "react";
import { AllSizes, RefWindow, type SizeName } from "./RefWindow.tsx";

type Act = { id: string; name: string; detail: string; icon: IconName; kind: string; running?: string; url?: string; failed?: number; took?: string };

const PRIMARY: Act = { id: "dev", name: "dev", detail: "Electron with hot reload; starts a core if none is running", icon: "play", kind: "Dev", running: "4m 12s", url: "localhost:5173" };
const ACTS: Act[] = [
  { id: "test", name: "test", detail: "Vitest, all packages", icon: "check-circle", kind: "Test", took: "38s" },
  { id: "e2e", name: "e2e", detail: "Build, then drive the real app with Playwright", icon: "check-circle", kind: "Test", failed: 1 },
  { id: "e2e:motion", name: "e2e:motion", detail: "Score jumps, snaps and wobble frame by frame", icon: "check-circle", kind: "Test" },
  { id: "build", name: "build", detail: "Bundle the desktop app", icon: "hammer", kind: "Build", took: "1m 04s" },
  { id: "dist", name: "dist", detail: "Package a signed cmd dev build", icon: "hammer", kind: "Build" },
  { id: "typecheck", name: "typecheck", detail: "tsc for the packages and the desktop app", icon: "list-checks", kind: "Check", took: "12s" },
  { id: "ui", name: "workbench", detail: "The UI Workbench: every component and story", icon: "terminal-window", kind: "Other" },
  { id: "workbench", name: "workbench", detail: "One component from a story, in the real app", icon: "terminal-window", kind: "Other" },
  { id: "release", name: "release", detail: "Bump, tag and push; CI publishes the release", icon: "paper-plane-tilt", kind: "Deploy" },
  { id: "core:stop", name: "core:stop", detail: "Stop this instance's core", icon: "trash", kind: "Clean" },
];
const KINDS = ["Test", "Build", "Check", "Other", "Deploy", "Clean"];

function Row({ a, big }: { a: Act; big?: boolean }) {
  return (
    <ListRow>
      <ListRowIcon icon={a.icon} light={a.running ? "working" : a.failed ? "danger" : undefined} />
      <ListRowContent title={a.name} mono detail={a.failed ? `Failed · exit ${a.failed}` : a.detail} tone={a.failed ? "danger" : undefined} />
      <ListRowEnd>
        {a.url && (
          <LinkButton tone="accent" onClick={(e) => e.stopPropagation()}>
            {a.url}
          </LinkButton>
        )}
        {(a.running ?? a.took) && <ListValue>{a.running ?? a.took}</ListValue>}
        {big && !a.running && (
          <Button size="sm" variant="primary" icon="play">
            Run
          </Button>
        )}
      </ListRowEnd>
      <ListRowActions>
        {a.running ? (
          <>
            <IconButton size="sm" icon="arrow-clockwise" label="Restart" />
            <IconButton size="sm" icon="stop" label="Stop" />
          </>
        ) : big ? undefined : (
          <IconButton size="sm" icon="play" label="Run" />
        )}
      </ListRowActions>
    </ListRow>
  );
}

function Actions({ size = "regular", query: q0 = "", state, describing, idle }: { size?: SizeName; query?: string; state?: ViewStateSpec; describing?: boolean; idle?: boolean }) {
  const [q, setQ] = useState(q0);
  const primary = idle ? { ...PRIMARY, running: undefined, url: undefined } : PRIMARY;
  const all = [primary, ...ACTS];
  const matches = all.filter((a) => (a.name + a.detail).toLowerCase().includes(q.toLowerCase()));
  const running = all.filter((a) => a.running).length;
  const failed = all.filter((a) => a.failed).length;
  const body: ViewStateSpec | undefined = state ?? (q && !matches.length ? { kind: "noResults", text: `Nothing here is called “${q}”.` } : undefined);
  return (
    <RefWindow icon="monitor-play" name="Workspace Actions · cmd" size={size}>
      <View
        state={body}
        toolbar={
          <WindowToolbar label="Actions">
            <ToolbarSearchField value={q} onChange={setQ} placeholder="Filter actions" count={q ? String(matches.length) : undefined} minWidth={90} />
            <ToolbarSpacer />
            <ToolbarButton icon="arrow-counter-clockwise" label="Run Last Action Again" shortcut="⇧⌘R" secondary priority={1} />
          </WindowToolbar>
        }
        footer={
          <StatusLine
            end={
              <>
                <Icon name="git-branch" size={11} /> window-design · ~/src/cmd
              </>
            }
          >
            {describing ? (
              <>
                <Spinner size={10} /> Describing actions…
              </>
            ) : (
              <>
                {all.length} actions{running ? ` · ${running} running` : ""}
                {failed ? ` · ${failed} failed` : ""}
              </>
            )}
          </StatusLine>
        }
      >
        <List>
          {q ? (
            <ListSection title="Matches" count={matches.length}>
              {matches.map((a) => (
                <Row key={a.id} a={a} />
              ))}
            </ListSection>
          ) : (
            <>
              <ListGroup>
                <Row a={primary} big />
              </ListGroup>
              {KINDS.map((k) => {
                const rows = ACTS.filter((a) => a.kind === k);
                return (
                  <ListSection key={k} title={k} count={rows.length}>
                    {rows.map((a) => (
                      <Row key={a.id} a={a} />
                    ))}
                  </ListSection>
                );
              })}
            </>
          )}
        </List>
      </View>
    </RefWindow>
  );
}

export const Default = () => <Actions />;
export const Sizes = () => <AllSizes render={(s) => <Actions size={s} />} />;
export const Idle = () => <Actions idle />;
export const Filtered = () => <Actions query="e2e" />;
export const NoResults = () => <Actions query="deploy prod" />;
export const Describing = () => <Actions describing />;
export const Empty = () => <Actions state={{ kind: "empty", icon: "monitor-play", title: "Nothing to run here", text: "Scripts in package.json, a Makefile, a justfile and similar files show up here." }} />;
export const Failed = () => <Actions state={{ kind: "error", title: "Couldn’t read this folder", text: "~/src/cmd isn’t readable. Check its permissions and try again.", action: <Button icon="arrow-clockwise">Try Again</Button> }} />;
