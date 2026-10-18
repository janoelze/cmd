// Every built-in theme at once (the registry): each card a .ui-theme subtree with the
// theme's tokens on it, the same few controls in each, so a theme that loses one shows.
import { useState, type CSSProperties } from "react";
import { Button } from "./button.tsx";
import { Segmented, Switch } from "./choice.tsx";
import { TextField } from "./fields.tsx";
import { Badge, StatusDot } from "./status.tsx";
import { allThemes, themeVars } from "./themes/registry.ts";

/** Each theme's name and appearance, a primary and a plain button, a switch, a segmented control, a field, the tones. */
export const All = () => {
  const [on, setOn] = useState(true);
  const [seg, setSeg] = useState("grid");
  return (
    <div style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(250px, 1fr))", gap: "var(--space-3)", width: 820 }}>
      {allThemes().map((t) => (
        <div key={t.id} className="ui-theme" data-appearance={t.appearance} style={{ ...(themeVars(t) as CSSProperties), display: "flex", flexDirection: "column", gap: "var(--space-3)", padding: "var(--space-3)", color: "var(--text)", fontSize: "var(--text-base)", borderRadius: "var(--radius-md)", background: "var(--bg)", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-1-5)", fontWeight: 600 }}>
            <StatusDot state="working" />
            {t.title}
            <span style={{ flex: 1 }} />
            <Badge size="sm">{t.appearance}</Badge>
          </div>
          <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", padding: "var(--space-3)", borderRadius: "var(--radius)", background: "var(--well)" }}>
            <div style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
              <Button variant="primary" size="sm">
                Save
              </Button>
              <Button size="sm">Cancel</Button>
              <Switch size="sm" checked={on} onChange={setOn} label="On" />
            </div>
            <Segmented size="sm" value={seg} onChange={setSeg} options={["grid", "strip", "focus"]} labels={{ grid: "Grid", strip: "Strip", focus: "Focus" }} />
            <TextField size="sm" value="" placeholder="Search" icon="magnifying-glass" fill onChange={() => {}} />
            <div style={{ display: "flex", gap: "var(--space-1-5)" }}>
              <Badge tone="accent">accent</Badge>
              <Badge tone="success">ok</Badge>
              <Badge tone="warning">needs</Badge>
              <Badge tone="danger">failed</Badge>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
};
