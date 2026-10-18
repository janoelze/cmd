// Overlays that need more than a native menu or confirm: a menu with icons, details and
// shortcuts; a popover card; a sheet whose content works while it shows (Presence); a
// confirmation; toasts. The menus, popover and confirmation start open.
import { Fragment, useEffect, useRef, useState } from "react";
import { Button, ButtonGroup } from "./button.tsx";
import { Checkbox, Segmented, Select } from "./choice.tsx";
import { SearchField, TextArea } from "./fields.tsx";
import { FeatureList, KeyValue, Prose, SectionHeading, SheetHeader } from "./layout.tsx";
import { Badge, PageDots } from "./status.tsx";
import { ConfirmDialog, Dialog, Menu, Popover, Presence, Toast, Toaster, toast } from "./overlay.tsx";
import { StatusDot } from "./status.tsx";

const WORKSPACES = { work: "Work", home: "Home", side: "Side project", long: "fl-studio-canonical-store-migration" } as const;
type Workspace = keyof typeof WORKSPACES;

/** A workspace switcher: a heading, checkmarks, shortcuts, a separator, a destructive item with Undo. Arrow keys, Enter, type to jump. */
export const Workspaces = () => {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [ws, setWs] = useState<Workspace>("work");
  return (
    <div style={{ height: 300 }}>
      <Button ref={anchor} trailing="caret-up-down" onClick={() => setOpen(!open)}>
        {WORKSPACES[ws]}
      </Button>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        items={[
          "Workspaces",
          { label: "Work", detail: "4 windows · 2 agents", icon: "terminal-window", checked: ws === "work", shortcut: "⌃1", onSelect: () => setWs("work") },
          { label: "Home", detail: "1 window", icon: "house", checked: ws === "home", shortcut: "⌃2", onSelect: () => setWs("home") },
          { label: "Side project", icon: "sparkle", checked: ws === "side", shortcut: "⌃3", onSelect: () => setWs("side") },
          null,
          { label: "New Workspace…", icon: "plus", onSelect: () => toast("New Workspace") },
          { label: "Delete Workspace", icon: "trash", danger: true, onSelect: () => toast("Deleted", { tone: "danger", action: { label: "Undo", run: () => toast("Restored") } }) },
        ]}
      />
    </div>
  );
};

/** One line per item: the current row tinted instead of a checkmark, details beside the labels, accessories before shortcuts; as wide as its widest item up to maxWidth, then the detail gives way. */
export const Inline = () => {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  const [ws, setWs] = useState<Workspace>("work");
  return (
    <div style={{ height: 280, width: 480, display: "flex", justifyContent: "center" }}>
      <Button ref={anchor} trailing="caret-down" onClick={() => setOpen(!open)}>
        {WORKSPACES[ws]}
      </Button>
      <Menu
        anchor={anchor}
        open={open}
        onClose={() => setOpen(false)}
        align="center"
        marks="row"
        inline
        width="content"
        maxWidth={400}
        items={[
          { label: "Work", detail: "~/src/work", icon: "terminal-window", checked: ws === "work", shortcut: "⌃1", onSelect: () => setWs("work") },
          { label: "Home", detail: "~", icon: "house", checked: ws === "home", accessory: <StatusDot state="needs" size="sm" />, shortcut: "⌃2", onSelect: () => setWs("home") },
          { label: "Side project", detail: "~/src/side-project", icon: "sparkle", checked: ws === "side", accessory: <StatusDot state="unseen" size="sm" />, shortcut: "⌃3", onSelect: () => setWs("side") },
          { label: "fl-studio-canonical-store-migration", detail: "~/src/fl-studio-canonical-store-migration · worktree of fl-studio-store", icon: "folder", checked: ws === "long", shortcut: "⌃4", onSelect: () => setWs("long") },
          null,
          { label: "Open Workspace…", icon: "plus", shortcut: "⌘O", onSelect: () => toast("Open Workspace") },
        ]}
      />
    </div>
  );
};

/** A card under its button: details and an action (the core's status in the footer). */
export const Card = () => {
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(true);
  return (
    <div style={{ height: 220 }}>
      <Button ref={anchor} icon="info" onClick={() => setOpen(!open)}>
        Core details
      </Button>
      <Popover anchor={anchor} open={open} onClose={() => setOpen(false)} width={280}>
        <div style={{ padding: "var(--space-2) var(--space-3)", display: "flex", flexDirection: "column", gap: "var(--space-1-5)" }}>
          <SectionHeading aside={<StatusDot state="unseen" size="sm" />}>Core</SectionHeading>
          <KeyValue
            items={[
              ["Build", "4f670fc"],
              ["Uptime", "3h 12m"],
              ["Terminals", "7"],
            ]}
          />
          <ButtonGroup align="end">
            <Button size="sm">Restart</Button>
          </ButtonGroup>
        </div>
      </Popover>
    </div>
  );
};

/** Polls while it's mounted (window.__polls counts, so a test sees a closed one stop); Presence keeps it mounted while shown and while it fades out, then not at all. */
function PollingSheet({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [polls, setPolls] = useState(0);
  useEffect(() => {
    const w = window as { __polls?: number };
    const t = setInterval(() => (setPolls((n) => n + 1), (w.__polls = (w.__polls ?? 0) + 1)), 50);
    return () => clearInterval(t);
  }, []);
  return (
    <Dialog open={open} onClose={onClose} title="Task Manager" width={360} position="center" actions={<Button onClick={onClose}>Done</Button>}>
      Polled {polls} times since it opened.
    </Dialog>
  );
}

/** A sheet whose content does work: it stops polling once closed. */
export const Mounted = () => {
  const [shown, setShown] = useState(false);
  return (
    <>
      <Button onClick={() => setShown(true)}>Task Manager…</Button>
      <Presence when={shown}>{(_, open) => <PollingSheet open={open} onClose={() => setShown(false)} />}</Presence>
    </>
  );
};

/** Asking before something that can't be undone: the danger button is the confirm. */
export const Confirm = () => {
  const [open, setOpen] = useState(true);
  return (
    <>
      <Button variant="danger" onClick={() => setOpen(true)}>
        Delete Workspace…
      </Button>
      <ConfirmDialog open={open} danger title="Delete “Side project”?" confirm="Delete" onCancel={() => setOpen(false)} onConfirm={() => setOpen(false)}>
        Its 3 windows close. Terminals in it are ended.
      </ConfirmDialog>
    </>
  );
};

/** Toasts in place, each tone, one with an action. */
export const Toasts = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", width: 360 }}>
    <Toast onDismiss={() => {}}>Copied path</Toast>
    <Toast tone="success" icon="check-circle" onDismiss={() => {}}>
      Widget rebuilt
    </Toast>
    <Toast tone="warning" icon="warning" action={{ label: "Undo", run: () => {} }} onDismiss={() => {}}>
      Window closed
    </Toast>
  </div>
);

/** toast() from anywhere, shown by the window's Toaster at its corner (the UI Workbench has one; this is a second, so each shows twice in place). */
export const Toasting = () => (
  <div style={{ display: "flex", gap: "var(--space-2)" }}>
    <Button onClick={() => toast("Copied path")}>Plain</Button>
    <Button onClick={() => toast("Widget rebuilt", { tone: "success", icon: "check-circle" })}>Success</Button>
    <Button onClick={() => toast("Window closed", { action: { label: "Undo", run: () => toast("Reopened") } })}>With action</Button>
    <Toaster />
  </div>
);

/**
 * The sheets the app opens, each from its button: one shape (centred, the kit's title row or a
 * SheetHeader when it greets, the body's controls 12px apart, a footer with the aside across
 * from the actions). Send Feedback has fields and a Select, the Widget Library a field that
 * takes focus itself and a body that scrolls under it, What's New a divided one, the Task
 * Manager works while it shows. Modal: Tab stays inside, the page behind is inert, Escape
 * closes from anywhere inside and focus goes back to the button (packages/ui/test/dialog.test.ts).
 */
export const Sheets = () => {
  const [open, setOpen] = useState<null | "feedback" | "delete" | "news" | "welcome" | "library">(null);
  const [polling, setPolling] = useState(false);
  const [msg, setMsg] = useState("");
  const [area, setArea] = useState("terminals");
  const close = () => setOpen(null);
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: "var(--space-2)" }}>
      <Button onClick={() => setOpen("feedback")}>Send Feedback…</Button>
      <Button variant="danger" onClick={() => setOpen("delete")}>
        Delete Workspace…
      </Button>
      <Button onClick={() => setOpen("news")}>What's New</Button>
      <Button onClick={() => setOpen("welcome")}>Welcome</Button>
      <Button onClick={() => setOpen("library")}>Widget Library</Button>
      <Button onClick={() => setPolling(true)}>Task Manager…</Button>
      <Dialog
        open={open === "feedback"}
        onClose={close}
        title="Send Feedback"
        width={480}
        position="center"
        aside={
          <Checkbox checked onChange={() => {}}>
            Include version and system info
          </Checkbox>
        }
        actions={
          <>
            <Button onClick={close}>Cancel</Button>
            <Button variant="primary" disabled={!msg.trim()} onClick={() => (close(), setMsg(""), toast("Thanks!", { tone: "success", icon: "check-circle" }))}>
              Send
            </Button>
          </>
        }
      >
        <Segmented fill value="idea" onChange={() => {}} options={["bug", "idea", "other"]} labels={{ bug: "Bug", idea: "Idea", other: "Other" }} />
        <Select label="Area" value={area} onChange={setArea} options={["terminals", "agents", "windows"]} labels={{ terminals: "Terminals", agents: "Agents", windows: "Windows" }} />
        <TextArea value={msg} onChange={setMsg} placeholder="What happened, or what would you like?" rows={4} />
      </Dialog>
      <ConfirmDialog open={open === "delete"} danger title="Delete “Side project”?" confirm="Delete" onCancel={close} onConfirm={close}>
        Its 3 windows close. Terminals in it are ended.
      </ConfirmDialog>
      <Dialog
        open={open === "news"}
        onClose={close}
        title="What's New"
        width={560}
        position="center"
        divided
        aside="You're on cmd 0.14.1"
        actions={
          <Button variant="primary" onClick={close}>
            Done
          </Button>
        }
      >
        <Prose>
          {Array.from({ length: 4 }, (_, i) => (
            <Fragment key={i}>
              {i > 0 && <hr />}
              <h3>
                0.14.{4 - i} <small>5 October 2026</small>
              </h3>
              <Badge size="sm" tone="accent">
                New
              </Badge>
              <ul>
                <li>
                  <strong>PDF viewer.</strong> PDFs open in their own window, with search and <code>⌘F</code>.
                </li>
                <li>Release notes scroll between the title and the actions.</li>
              </ul>
            </Fragment>
          ))}
        </Prose>
      </Dialog>
      <Dialog
        open={open === "welcome"}
        onClose={close}
        width={480}
        height={560}
        position="center"
        label="Welcome"
        aside={<PageDots count={2} current={0} />}
        actions={
          <Button variant="primary" onClick={close}>
            Get Started
          </Button>
        }
      >
        <SheetHeader icon="command" title="Welcome to cmd" subtitle="Terminals and coding agents, side by side." />
        <FeatureList
          items={[
            { icon: "layout", title: "A workspace per project", description: "Terminals, agents, a browser and an editor as windows." },
            { icon: "magic-wand", title: "Magic widgets", description: "Ask for a window and an agent builds it." },
          ]}
        />
      </Dialog>
      <Dialog
        open={open === "library"}
        onClose={close}
        title="Widget Library"
        width={560}
        height={420}
        position="center"
        divided
        toolbar={<SearchField fill size="lg" value="" placeholder="Search widgets" onChange={() => {}} autoFocus />}
        aside="Right-click a widget to rename, duplicate or delete it"
        actions={
          <Button variant="primary" icon="sparkle" onClick={close}>
            New Widget
          </Button>
        }
      >
        <SectionHeading>Built-in</SectionHeading>
        {Array.from({ length: 10 }, (_, i) => (
          <p key={i} style={{ margin: 0 }}>
            The body scrolls under the toolbar, line {i + 1}.
          </p>
        ))}
      </Dialog>
      <Presence when={polling}>{(_, o) => <PollingSheet open={o} onClose={() => setPolling(false)} />}</Presence>
    </div>
  );
};
