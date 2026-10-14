// A package widget's edit view (docs/56, "Revisions"), ⌘E on the window of a widget made with
// Magic (withMagicEdit wraps the package view, windows/package/register.tsx):
//  - Changes: ask for a change (Edit with Magic builds it beside the window), and every version
//    so far: what was asked, a screenshot, whether its checks passed, any of which comes back
//    with Restore (refused for a linked package, whose folder is the person's own).
//  - Files: the package's folder; files open in cmd, and a save anywhere (by hand, by Claude
//    Code) reloads the widget and becomes a version, "Edited by hand".

import { useEffect, useRef, useState, useSyncExternalStore, type ComponentType, type ReactNode } from "react";
import type { AppWindow, MagicPackageInfo, MagicRevision } from "@cmd/protocol";
import {
  Badge,
  Button,
  ButtonGroup,
  Callout,
  EmptyState,
  FormRow,
  FormSection,
  Inline,
  LinkButton,
  List,
  ListRow,
  ListRowContent,
  ListRowEnd,
  Page,
  Spacer,
  StatusDot,
  Text,
  TextArea,
  Thumb,
  ToolbarButton,
  ToolbarSegmented,
  ToolbarSpacer,
  View,
  WindowToolbar,
} from "@cmd/ui";
import { cmd } from "../../lib/bridge.ts";
import { copy, openPath } from "../../lib/actions.ts";
import { ago } from "../../lib/model.ts";
import { useStoreValue } from "../../lib/store.ts";
import { registerWindowActions } from "../../lib/windowActions.ts";
import type { WindowViewProps } from "../registry.ts";

// Which windows show their edit view (kept across remounts, not across restarts).
let editing = new Set<string>();
const editListeners = new Set<() => void>();
export function setEditing(id: string, on: boolean): void {
  if (editing.has(id) === on) return;
  editing = new Set(editing);
  if (on) editing.add(id);
  else editing.delete(id);
  for (const fn of editListeners) fn();
}
function useEditing(id: string): boolean {
  const set = useSyncExternalStore(
    (fn) => (editListeners.add(fn), () => editListeners.delete(fn)),
    () => editing,
  );
  return set.has(id);
}

/** A package window's view with ⌘E: the edit view, for a widget made with Magic. */
export function withMagicEdit(Inner: ComponentType<WindowViewProps>): ComponentType<WindowViewProps> {
  return function MagicEditable(props: WindowViewProps) {
    const { win } = props;
    const made = useStoreValue((s) => !!s.library.find((e) => e.kind === win.kind)?.magic);
    const edit = useEditing(win.id) && made;
    useEffect(() => (made ? registerWindowActions(win.id, { toggleEdit: () => setEditing(win.id, !editing.has(win.id)) }) : undefined), [win.id, made]);
    return edit ? <MagicEditor win={win} onClose={() => setEditing(win.id, false)} /> : <Inner {...props} />;
  };
}

type Tab = "changes" | "files";
const TABS: { value: Tab; label: string }[] = [
  { value: "changes", label: "Changes" },
  { value: "files", label: "Files" },
];

const fileUrl = (p: string) => `cmd-file://local/?path=${encodeURIComponent(p)}`;

export function MagicEditor({ win, onClose }: { win: AppWindow; onClose: () => void }) {
  const [tab, setTab] = useState<Tab>("changes");
  const [info, setInfo] = useState<MagicPackageInfo | null>(null);
  const [error, setError] = useState<string | null>(null);
  // Asked again whenever the Library changes (a build, a Restore, a hand edit).
  const library = useStoreValue((s) => s.library);
  const [asked, setAsked] = useState(0);
  useEffect(() => {
    let alive = true;
    void cmd.call("magic.package", { windowId: win.id }).then((i) => alive && setInfo(i), () => alive && setInfo(null));
    return () => void (alive = false);
  }, [win.id, library, asked]);
  const restore = (n: number) => {
    setError(null);
    void cmd.call("magic.restorePackage", { windowId: win.id, revision: n }).then(
      () => setAsked((x) => x + 1),
      (e: Error) => setError(e.message),
    );
  };
  return (
    <View
      className="magic-edit"
      inset
      toolbar={
        <WindowToolbar label="Widget editor">
          <ToolbarSegmented label="Editor" value={tab} onChange={setTab} options={TABS} />
          <ToolbarSpacer />
          <ToolbarButton label="Done" shortcut="⌘E" tip="Back to the widget" onClick={onClose} />
        </WindowToolbar>
      }
    >
      <Page>
        {error && (
          <Callout tone="danger" onDismiss={() => setError(null)}>
            {error}
          </Callout>
        )}
        {tab === "changes" ? <Changes win={win} info={info} onRestore={restore} /> : <Files info={info} />}
      </Page>
    </View>
  );
}

const Dim = ({ children }: { children: ReactNode }) => (
  <Text size="sm" tone="dim">
    {children}
  </Text>
);

// ── Changes ─────────────────────────────────────────────

function Changes({ win, info, onRestore }: { win: AppWindow; info: MagicPackageInfo | null; onRestore: (n: number) => void }) {
  const [text, setText] = useState("");
  const ref = useRef<HTMLTextAreaElement>(null);
  useEffect(() => ref.current?.focus(), []);
  const building = !!info?.building;
  const submit = () => {
    if (!text.trim() || building) return;
    void cmd.call("magic.editPackage", { windowId: win.id, prompt: text.trim() });
    setText("");
  };
  const revisions = [...(info?.revisions ?? [])].reverse();
  const shown = info && !info.edited ? info.revisions.at(-1)?.n : undefined;
  return (
    <>
      <FormSection title="Change It" plain>
        <TextArea
          ref={ref}
          rows={3}
          autoGrow={10}
          placeholder={building ? "Wait for the change being made to finish…" : "What should change? “bigger numbers”, “add humidity”, “show the last 7 days”"}
          value={text}
          disabled={building}
          onChange={setText}
          onSubmit={submit}
          submitOnEnter
        />
        <Inline gap={2}>
          <Dim>⏎ to send · the widget stays as it is until the change works</Dim>
          <Spacer />
          <Button variant="primary" disabled={building || !text.trim()} onClick={submit}>
            Change
          </Button>
        </Inline>
      </FormSection>
      <FormSection title="Versions" aside={info?.edited ? "files edited since the last version" : undefined} plain>
        {info?.link && <Callout compact>Linked from your own folder, so Restore is off: cmd doesn't write into it.</Callout>}
        {!revisions.length && <EmptyState compact icon="clock.arrow.circlepath" title="No versions yet" />}
        <List>
          {revisions.map((r) => (
            <Version key={r.n} r={r} shown={r.n === shown} restore={!info?.link && !building ? () => onRestore(r.n) : undefined} />
          ))}
        </List>
      </FormSection>
    </>
  );
}

function Version({ r, shown, restore }: { r: MagicRevision; shown: boolean; restore?: () => void }) {
  const checks = r.hand ? "edited outside cmd" : r.ok ? "checks passed" : `${r.problems?.length ?? "some"} problem${r.problems?.length === 1 ? "" : "s"} left`;
  return (
    <ListRow className="magic-revision" tip={r.prompt}>
      <Thumb src={r.shot ? fileUrl(r.shot) : null} />
      <ListRowContent
        title={shown ? <Text strong>{r.prompt}</Text> : r.prompt}
        detail={
          <Inline gap={1}>
            <StatusDot size="sm" state={r.hand ? "off" : r.ok ? "success" : "warning"} />
            {checks} · {ago(r.at, Date.now())}
            {r.model ? ` · ${r.model}` : ""} · v{r.n}
          </Inline>
        }
      />
      <ListRowEnd>
        {shown ? (
          <Badge>shown</Badge>
        ) : (
          <Button size="sm" disabled={!restore} onClick={restore}>
            Restore
          </Button>
        )}
      </ListRowEnd>
    </ListRow>
  );
}

// ── Files ───────────────────────────────────────────────

function Files({ info }: { info: MagicPackageInfo | null }) {
  if (!info) return <EmptyState compact icon="folder" title="No package folder" />;
  const dir = info.link ?? info.dir;
  return (
    <>
      <FormSection
        title="Files"
        aside={
          <ButtonGroup>
            <LinkButton onClick={() => cmd.revealPath(dir)}>Show in Finder</LinkButton>
            <LinkButton onClick={() => copy(dir)}>Copy Path</LinkButton>
          </ButtonGroup>
        }
      >
        {info.files.map((f) => (
          <FormRow key={f} compact title={<Text mono>{f}</Text>}>
            <Button size="sm" onClick={() => void openPath(`${dir}/${f}`, "user")}>
              Open
            </Button>
          </FormRow>
        ))}
      </FormSection>
      <Dim>
        Edit them in cmd or anywhere else (Claude Code too: <code>cmd widget check {dir}</code> checks its package.json). A save reloads the widget and becomes a version.
      </Dim>
    </>
  );
}
