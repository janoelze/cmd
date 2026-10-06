// Workbench stories (pnpm workbench windowtoolbar): the kit's WindowToolbar as each
// window type uses it, at the widths windows get (a narrow sidebar to a wide tile),
// selected and at rest. The toolbars here are the specs the views follow.

import {
  ToolbarButton,
  ToolbarField,
  ToolbarGroup,
  ToolbarMenu,
  ToolbarPath,
  ToolbarSegmented,
  ToolbarSeparator,
  ToolbarSpacer,
  ToolbarText,
  Window,
  WindowBar,
  WindowBody,
  WindowFrame,
  WindowToolbar,
} from "@cmd/ui";
import { useState, type ReactNode } from "react";

const WIDTHS = [220, 320, 480, 640];

function Browser() {
  const [url, setUrl] = useState("github.com/janoelze/cmd/pulls");
  return (
    <WindowToolbar label="Browser">
      <ToolbarGroup>
        <ToolbarButton icon="chevron.left" label="Back" shortcut="⌘[" />
        <ToolbarButton icon="chevron.right" label="Forward" shortcut="⌘]" disabled />
        <ToolbarButton icon="arrow.clockwise" label="Reload" shortcut="⌘R" priority={2} />
      </ToolbarGroup>
      <ToolbarField value={url} onChange={(e) => setUrl(e.target.value)} placeholder="Enter a URL" minWidth={90} />
      <ToolbarButton icon="safari" label="Open in Default Browser" secondary priority={1} />
    </WindowToolbar>
  );
}

function Files() {
  const [hidden, setHidden] = useState(false);
  const [changes, setChanges] = useState(false);
  const segs = ["~", "src", "cmd", "apps", "desktop"].map((s, i) => ({ key: String(i), label: s }));
  return (
    <WindowToolbar label="Files">
      <ToolbarButton icon="chevron.up" label="Enclosing Folder" shortcut="⌘↑" />
      <ToolbarPath segments={segs} onSelect={() => {}} onMenu={() => {}} tip="~/src/cmd/apps/desktop" />
      <ToolbarSpacer />
      <ToolbarButton icon="arrow.triangle.branch" label="Changes Only" showLabel pressed={changes} badge="12" onClick={() => setChanges((c) => !c)} priority={4} />
      <ToolbarButton icon="bookmark" label="Bookmarks" menu secondary priority={2} />
      <ToolbarButton icon={hidden ? "eye" : "eye.slash"} label={hidden ? "Hide Hidden Files" : "Show Hidden Files"} pressed={hidden} onClick={() => setHidden((h) => !h)} secondary priority={1} />
      <ToolbarButton icon="terminal" label="New Terminal Here" secondary priority={3} />
    </WindowToolbar>
  );
}

function Pdf() {
  const [sidebar, setSidebar] = useState(false);
  return (
    <WindowToolbar label="PDF">
      <ToolbarButton icon="sidebar.left" label={sidebar ? "Hide Sidebar" : "Show Sidebar"} pressed={sidebar} onClick={() => setSidebar((s) => !s)} priority={2} />
      <ToolbarField defaultValue="3" aria-label="Page" minWidth={36} maxWidth={44} style={{ textAlign: "center" }} />
      <ToolbarText priority={0}>of 24</ToolbarText>
      <ToolbarSpacer />
      <ToolbarGroup>
        <ToolbarButton icon="minus.magnifyingglass" label="Zoom Out" shortcut="⌘−" priority={1} />
        <ToolbarMenu label="Zoom" onClick={() => {}} priority={3}>
          125%
        </ToolbarMenu>
        <ToolbarButton icon="plus.magnifyingglass" label="Zoom In" shortcut="⌘+" priority={1} />
      </ToolbarGroup>
      <ToolbarSeparator />
      <ToolbarButton icon="magnifyingglass" label="Find" shortcut="⌘F" />
    </WindowToolbar>
  );
}

function Events() {
  const [q, setQ] = useState("");
  return (
    <WindowToolbar label="Filter events">
      <ToolbarField icon="magnifyingglass" value={q} onChange={(e) => setQ(e.target.value)} placeholder="Filter events" end={q ? "12" : undefined} />
      <ToolbarButton icon="pause" label="Pause" showLabel secondary priority={1} />
    </WindowToolbar>
  );
}

function Editor() {
  const [tab, setTab] = useState<"changes" | "settings" | "files" | "health">("changes");
  return (
    <WindowToolbar label="Widget editor">
      <ToolbarSegmented
        label="Editor"
        value={tab}
        onChange={setTab}
        options={[
          { value: "changes", label: "Changes" },
          { value: "settings", label: "Settings" },
          { value: "files", label: "Files" },
          { value: "health", label: "Health" },
        ]}
      />
      <ToolbarSpacer />
      <ToolbarButton icon="checkmark" label="Done" shortcut="⌘E" showLabel />
    </WindowToolbar>
  );
}

const KINDS: { name: string; icon: string; bar: () => ReactNode }[] = [
  { name: "GitHub · Pull requests", icon: "globe", bar: Browser },
  { name: "desktop", icon: "folder", bar: Files },
  { name: "manual.pdf", icon: "doc.richtext", bar: Pdf },
  { name: "Event Stream", icon: "waveform.path.ecg", bar: Events },
  { name: "Weather", icon: "sparkles", bar: Editor },
];

function Win({ width, icon, name, selected, children }: { width: number; icon: string; name: string; selected?: boolean; children: ReactNode }) {
  return (
    <Window selected={selected} style={{ width, height: 92, position: "relative", flex: "none" }}>
      <WindowBody style={{ display: "flex", flexDirection: "column", height: "100%" }}>
        <WindowBar icon={icon} name={name} />
        {children}
        <div style={{ flex: 1, background: "var(--well)" }} />
      </WindowBody>
      <WindowFrame />
    </Window>
  );
}

const Stage = ({ children }: { children: ReactNode }) => <div style={{ display: "flex", flexDirection: "column", gap: 14, padding: 16, maxWidth: "100%" }}>{children}</div>;

/** Every toolbar at every width; the first of each row selected. */
export const Widths = () => (
  <Stage>
    {KINDS.map((k) => (
      <div key={k.name} style={{ display: "flex", flexWrap: "wrap", gap: 12, alignItems: "flex-start" }}>
        {WIDTHS.map((w, i) => (
          <Win key={w} width={w} icon={k.icon} name={k.name} selected={i === WIDTHS.length - 1}>
            <k.bar />
          </Win>
        ))}
      </div>
    ))}
  </Stage>
);

/** Selected beside at rest: secondary items faded on the one at rest. */
export const Rest = () => (
  <Stage>
    {KINDS.map((k) => (
      <div key={k.name} style={{ display: "flex", gap: 12 }}>
        <Win width={480} icon={k.icon} name={k.name} selected>
          <k.bar />
        </Win>
        <Win width={480} icon={k.icon} name={k.name}>
          <k.bar />
        </Win>
      </div>
    ))}
  </Stage>
);

/** Drag the handle: one window, any width. */
export const Resize = () => {
  const [w, setW] = useState(420);
  return (
    <Stage>
      <input type="range" min={160} max={900} value={w} onChange={(e) => setW(Number(e.target.value))} style={{ width: 300 }} />
      {KINDS.map((k) => (
        <Win key={k.name} width={w} icon={k.icon} name={k.name} selected>
          <k.bar />
        </Win>
      ))}
    </Stage>
  );
};
