// Reference window, content (pnpm workbench contentwindow): a document to read,
// in a column at a reading width, with its outline in a sidebar that follows
// the scroll. The spec for Markdown, the Journal, What's New and any window
// whose content is text.

import { Badge, Callout, CodeBlock, Inline, ListRow, Measure, Prose, Split, Stack, StatusLine, Text, ToolbarButton, ToolbarSearchField, ToolbarSpacer, View, WindowToolbar } from "@cmd/ui";
import { useState } from "react";
import { AllSizes, RefWindow, type SizeName } from "./RefWindow.tsx";

const OUTLINE = [
  { id: "what", title: "Window design", depth: 0 },
  { id: "today", title: "What cmd has today", depth: 1 },
  { id: "others", title: "What other systems do", depth: 1 },
  { id: "prims", title: "Layout primitives", depth: 2 },
  { id: "templates", title: "Window templates", depth: 2 },
  { id: "resp", title: "Responsive to the panel", depth: 2 },
  { id: "plan", title: "Plan", depth: 1 },
];

function Doc({ size = "wide", loading }: { size?: SizeName; loading?: boolean }) {
  const [outline, setOutline] = useState(true);
  const [q, setQ] = useState("");
  const [at, setAt] = useState("today");
  return (
    <RefWindow icon="doc.richtext" name="40-window-design.md" size={size}>
      <View
        scroll={false}
        state={loading ? { kind: "loading" } : null}
        toolbar={
          <WindowToolbar label="Document">
            <ToolbarButton icon="sidebar.left" label={outline ? "Hide Outline" : "Show Outline"} pressed={outline} onClick={() => setOutline((v) => !v)} priority={2} />
            <ToolbarSpacer />
            <ToolbarSearchField value={q} onChange={setQ} placeholder="Find" minWidth={80} />
            <ToolbarButton icon="pencil" label="Edit" shortcut="⌘E" secondary priority={1} />
          </WindowToolbar>
        }
        footer={<StatusLine end={<span>~/src/cmd/docs</span>}>2,140 words · 9 min read</StatusLine>}
      >
        <Split
          side="start"
          open={outline}
          width={{ min: 160, ideal: 200, max: 300 }}
          pane={
            <Stack gap="none" pad="xs">
              {OUTLINE.map((h) => (
                <ListRow key={h.id} title={h.title} depth={h.depth} selected={h.id === at} onClick={() => setAt(h.id)} />
              ))}
            </Stack>
          }
        >
          <Measure>
            <Stack gap="xl">
              <Stack gap="xs">
                <Inline gap="sm">
                  <Badge tone="accent">Research</Badge>
                  <Text tone="dim" size="sm">
                    9 October 2026
                  </Text>
                </Inline>
                <Text size="xl" strong>
                  Window design: one language for every window
                </Text>
              </Stack>
              <Prose>
                <p>
                  cmd has a kit with good colour discipline and solid controls, but the windows built from it don’t share a layout language: each picks its own paddings, bar heights, row heights and empty states.
                </p>
                <h2>What cmd has today</h2>
                <p>Colour comes from themes everywhere. Spacing doesn’t: the kit’s own CSS uses thirteen different gaps, and every window has its own inset.</p>
                <ul>
                  <li>No spacing scale, and no layout primitives.</li>
                  <li>Bars at 26, 28, 31, 32 and 34 px; rows at 22, 24, 28 and 38 px.</li>
                  <li>No window frame: SQLite, Settings and the Journal each build their own.</li>
                </ul>
              </Prose>
              <Callout tone="accent" title="The surprise">
                Magic’s prompt is the best written guide to cmd’s window design in the repo, and none of the built-in windows follow it.
              </Callout>
              <CodeBlock>{`<View toolbar={…} footer={…} state={state}>\n  <Split side="end" pane={<Inspector />}>…</Split>\n</View>`}</CodeBlock>
              <Prose>
                <h2>What other systems do</h2>
                <p>Braid’s rule: components never provide their own surrounding white space. Layout primitives space their children, from a named scale, and nothing else does.</p>
              </Prose>
            </Stack>
          </Measure>
        </Split>
      </View>
    </RefWindow>
  );
}

export const Default = () => <Doc />;
export const Sizes = () => <AllSizes render={(s) => <Doc size={s} />} />;
export const Loading = () => <Doc loading />;
