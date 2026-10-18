// Choosing, as views use it: Tabs (pills, underlined with icons, over their panels),
// Checkbox (in a list, with a parent that's mixed), RadioGroup (each choice explained).
import { useState } from "react";
import { Checkbox, RadioGroup, TabPanel, Tabs } from "./choice.tsx";

/** Pills, with a count and a dot that wants attention. Arrow keys move between tabs. */
export const Pills = () => {
  const [tab, setTab] = useState("changes");
  return (
    <Tabs
      value={tab}
      onChange={setTab}
      items={[
        { id: "changes", label: "Changes" },
        { id: "settings", label: "Settings" },
        { id: "files", label: "Files", badge: 6 },
        { id: "health", label: "Health", badge: "dot", tone: "warning" },
      ]}
    />
  );
};

/** Underlined, with icons: a window's pages. */
export const Underline = () => {
  const [tab, setTab] = useState("general");
  return (
    <Tabs
      variant="underline"
      value={tab}
      onChange={setTab}
      items={[
        { id: "general", label: "General", icon: "gear" },
        { id: "appearance", label: "Appearance", icon: "palette" },
        { id: "keyboard", label: "Keyboard", icon: "keyboard" },
      ]}
    />
  );
};

/** Tabs over their panels: each tab names its panel (idPrefix), so the panel is labelled by it. */
export const Panels = () => {
  const [tab, setTab] = useState("changes");
  return (
    <div style={{ width: 420, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      <Tabs idPrefix="wb-tabs" value={tab} onChange={setTab} items={[{ id: "changes", label: "Changes" }, { id: "files", label: "Files", badge: 6 }]} />
      <TabPanel idPrefix="wb-tabs" id={tab}>
        {tab === "changes" ? "3 files changed since the last version." : "6 files in this widget."}
      </TabPanel>
    </div>
  );
};

/** Permissions: a parent that is mixed while only some are on, children with descriptions, one disabled. */
export const Checkboxes = () => {
  const [checks, setChecks] = useState({ a: true, b: false, c: true });
  const all = Object.values(checks);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)" }}>
      <Checkbox checked={all.every(Boolean)} mixed={!all.every(Boolean) && all.some(Boolean)} onChange={(v) => setChecks({ a: v, b: v, c: v })}>
        All permissions
      </Checkbox>
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", paddingLeft: "var(--space-5)" }}>
        <Checkbox checked={checks.a} onChange={(v) => setChecks({ ...checks, a: v })} description="api.github.com, api.open-meteo.com">
          Network
        </Checkbox>
        <Checkbox checked={checks.b} onChange={(v) => setChecks({ ...checks, b: v })} description="Read files under ~/src">
          Files
        </Checkbox>
        <Checkbox checked={checks.c} onChange={(v) => setChecks({ ...checks, c: v })}>
          Environment variables
        </Checkbox>
      </div>
      <Checkbox checked disabled onChange={() => {}}>
        Disabled
      </Checkbox>
    </div>
  );
};

/** One of a few, each with room to explain; and side by side. */
export const Radios = () => {
  const [v, setV] = useState("tab");
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <RadioGroup value={v} onChange={setV} options={["tab", "window", "split"]} labels={{ tab: "In a new tab", window: "In a new window", split: "Beside the current one" }} descriptions={{ window: "Uses the window layout of the current workspace." }} />
      <RadioGroup horizontal value={v} onChange={setV} options={["tab", "window", "split"]} labels={{ tab: "Tab", window: "Window", split: "Split" }} />
    </div>
  );
};
