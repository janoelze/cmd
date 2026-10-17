// The window pieces that aren't lists or tables: what a view shows instead of its content
// (ViewState: loading, empty, no results, an error), the timer's Dial, a Document to read,
// a picture in a Viewport, media on a Stage, thumbnails, a Settings page under its
// TitleBand, and Hide (what gives way as a window narrows).
import { useState, type ReactNode } from "react";
import { Button } from "./button.tsx";
import { Dial, Document, Hide, Page, Picture, Stack, Stage, Text, Thumb, TitleBand, View, ViewState, Viewport, type ViewStateSpec } from "./frame.tsx";
import { FormRow, FormSection } from "./layout.tsx";
import { Switch } from "./choice.tsx";
import { Badge } from "./status.tsx";
import { picture } from "./fixtures.ts";

/** A box of a window's size for a piece that fills its view. */
const Box = ({ w = 360, h = 240, children }: { w?: number; h?: number; children: ReactNode }) => <div style={{ width: w, height: h, display: "flex", flexDirection: "column", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--well)", boxShadow: "inset 0 0 0 1px var(--separator)" }}>{children}</div>;

const STATES: ViewStateSpec[] = [
  { kind: "loading", title: "Reading the database…" },
  { kind: "empty", icon: "tray", title: "No runs yet", text: "Runs show up here once a workflow starts.", action: <Button>Run Workflow</Button> },
  { kind: "noResults", title: "No runs match “deploy”", action: <Button variant="ghost">Clear Filter</Button> },
  { kind: "error", title: "The runs didn't load", text: "gh: authentication required (run gh auth login in a terminal)", action: <Button>Try Again</Button> },
];

/** Every state side by side, each in a body of a window's size. */
export const States = () => (
  <div style={{ display: "flex", flexWrap: "wrap", gap: 16, width: 760 }}>
    {STATES.map((s) => (
      <div key={s.kind} style={{ width: 360, height: 220, display: "flex", borderRadius: "var(--radius-md)", background: "var(--bg)" }}>
        <ViewState state={s} />
      </div>
    ))}
  </div>
);

/** The timer: running (accent), done (needs, the ring full), paused (dim); click the value to edit it. */
export const Dials = () => {
  const [edit, setEdit] = useState<string | null>(null);
  return (
    <div style={{ display: "flex", gap: "var(--space-4)" }}>
      <Box w={220} h={220}>
        <Dial progress={0.62} value="12:24" caption="ends 14:32" label="Time left" onEdit={() => setEdit("12:24")} edit={edit !== null ? { text: edit, onChange: setEdit, onCommit: () => setEdit(null), onCancel: () => setEdit(null) } : undefined} />
      </Box>
      <Box w={220} h={220}>
        <Dial progress={1} tone="needs" value="Done" caption="at 14:32" label="Time left" />
      </Box>
      <Box w={220} h={220}>
        <Dial progress={0.3} tone="dim" value="6:00" caption="paused" label="Time left" />
      </Box>
    </div>
  );
};

/** A paragraph as it wraps by default (pretty: no lone last word), and `balance`d: lines of about one length, for a short intro under a title. */
export const Paragraphs = () => (
  <div style={{ width: 340 }}>
    <Stack gap={3}>
      <Text>This version brings your records up to date. It happens once.</Text>
      <Text balance>This version brings your records up to date. It happens once.</Text>
    </Stack>
  </div>
);

/** Rendered Markdown in a reading column: headings, a list, code, a quote, a table. */
export const Reading = () => (
  <Box w={560} h={360}>
    <View>
      <Document>
        <h1>Workspace Actions</h1>
        <p>
          Finds how to run the project in its workspace: <code>package.json</code> scripts, Make, just and more, parsed, never run.
        </p>
        <h2>What it reads</h2>
        <ul>
          <li>Scripts and their descriptions</li>
          <li>The commands you ran, to rank them</li>
        </ul>
        <blockquote>Deploys ask before they run.</blockquote>
        <pre>
          <code>pnpm dev # a terminal of its own</code>
        </pre>
        <table>
          <thead>
            <tr>
              <th>Source</th>
              <th>Found</th>
            </tr>
          </thead>
          <tbody>
            <tr>
              <td>package.json</td>
              <td>14</td>
            </tr>
            <tr>
              <td>Makefile</td>
              <td>3</td>
            </tr>
          </tbody>
        </table>
      </Document>
    </View>
  </Box>
);

/** A picture larger than its view (it scrolls, the grab cursor shows), and one still loading. */
export const Pictures = () => (
  <div style={{ display: "flex", gap: "var(--space-4)" }}>
    <Box>
      <Viewport pannable>
        <Picture src={picture(210, "screenshot.png", 900, 560)} alt="A screenshot" />
      </Viewport>
    </Box>
    <Box>
      <Viewport loading>
        <Picture src={picture(30, "", 200, 120)} alt="" />
      </Viewport>
    </Box>
  </div>
);

/** Media that fills its view on the scrim: a player, a visualizer. */
export const Media = () => (
  <Box w={480} h={270}>
    <Stage>
      <img src={picture(260, "Playing", 480, 270)} alt="" style={{ width: "100%", height: "100%", objectFit: "contain" }} />
    </Stage>
  </Box>
);

/** Thumbnails at a row's start: a screenshot cropped from its top left, and the placeholder without one. */
export const Thumbs = () => (
  <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
    <Thumb src={picture(140, "v3")} alt="Version 3" />
    <Thumb src={picture(330, "v2")} alt="Version 2" />
    <Thumb />
  </div>
);

/** A page of settings in a window of its own: its title in the band under the traffic lights, the line once the page scrolls. */
export const SettingsPage = () => {
  const [on, setOn] = useState(true);
  return (
    <Box w={620} h={320}>
      <View toolbar={<TitleBand title="General" line />}>
        <Page>
          <FormSection title="Notifications">
            <FormRow title="When an agent needs you" description="Only while its window isn't in front.">
              <Switch checked={on} onChange={setOn} label="When an agent needs you" />
            </FormRow>
          </FormSection>
        </Page>
      </View>
    </Box>
  );
};

/** A page opened from another: the back chevron before its title returns to that page. */
export const SettingsSubpage = () => (
  <Box w={620} h={200}>
    <View toolbar={<TitleBand title="Push Branch" back={{ label: "Quick Commands", onClick: () => {} }} />}>
      <Page>
        <FormSection>
          <FormRow title="Name">
            <Text>Push Branch</Text>
          </FormRow>
        </FormSection>
      </Page>
    </View>
  </Box>
);

/** Hide at three window widths: the badge gives way below the regular size (600px), the button below narrow (360px). */
export const Narrowing = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
    {[700, 480, 300].map((w) => (
      <Box key={w} w={w} h={56}>
        <View>
          <div style={{ display: "flex", alignItems: "center", gap: "var(--space-2)", padding: "var(--space-3) var(--inset)" }}>
            <span>{w}px</span>
            <Hide below="regular">
              <Badge tone="accent">regular and up</Badge>
            </Hide>
            <Hide below="narrow">
              <Button size="sm">narrow and up</Button>
            </Hide>
            <Hide above="narrow">
              <Badge>only narrow</Badge>
            </Hide>
          </div>
        </View>
      </Box>
    ))}
  </div>
);
