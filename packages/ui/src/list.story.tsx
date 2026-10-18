// Lists as the Commands widget and the sidebar draw them: a Panel with its header (a name
// that opens a menu, a summary, actions on hover), sections of rows built from slots (an
// icon that gives way to a status light, the content, an end that gives way to actions on
// hover, Chips for projects), a folding section, nesting with twisties, and Mark alone.
import { useState } from "react";
import { IconButton } from "./button.tsx";
import { Chip, List, ListHeading, ListRow, ListRowActions, ListRowContent, ListRowEnd, ListRowIcon, ListSection, ListValue, Mark, Panel, PanelBody, PanelHeader, PanelSummary, Twisty, TwistySpace } from "./list.tsx";

/** The Commands widget: running, then finished (it folds); a failed run in red with Run Again on hover. */
export const Commands = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ width: 360, height: 300, display: "flex", borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
      <Panel>
        <PanelHeader title="Commands" onTitleClick={() => {}} actions={<IconButton size="sm" icon="trash" label="Clear" />}>
          <PanelSummary tone="danger">1 failed</PanelSummary>
        </PanelHeader>
        <PanelBody>
          <List>
            <ListSection title="Running" count={1}>
              <ListRow>
                <ListRowIcon icon="terminal-window" light="working" />
                <ListRowContent mono title="pnpm dev" detail="Running · 4 min" />
                <ListRowEnd>
                  <Chip hue={200}>cmd</Chip>
                </ListRowEnd>
              </ListRow>
            </ListSection>
            <ListSection title="Finished" count={3} open={open} onToggle={() => setOpen((o) => !o)}>
              <ListRow>
                <ListRowIcon icon="terminal-window" light="danger" />
                <ListRowContent mono title="pnpm test" detail="Failed · exit 1 · 12 s" tone="danger" />
                <ListRowEnd>
                  <Chip hue={200}>cmd</Chip>
                  <ListValue>2m</ListValue>
                </ListRowEnd>
                <ListRowActions>
                  <IconButton size="sm" icon="arrow-clockwise" label="Run Again" />
                </ListRowActions>
              </ListRow>
              <ListRow selected>
                <ListRowIcon icon="terminal-window" />
                <ListRowContent mono title="git status" detail="0.2 s" />
                <ListRowEnd>
                  <ListValue>5m</ListValue>
                </ListRowEnd>
              </ListRow>
              <ListRow>
                <ListRowIcon icon="bell" />
                <ListRowContent title="One line, with a place" place="~/src/cmd" />
                <ListRowEnd>
                  <ListValue strong>84%</ListValue>
                </ListRowEnd>
              </ListRow>
            </ListSection>
          </List>
        </PanelBody>
      </Panel>
    </div>
  );
};

/** Rows under rows (an agent's subagents): a twisty where there are children, the same space where there aren't. */
export const Nested = () => {
  const [open, setOpen] = useState(true);
  return (
    <div style={{ width: 320 }}>
      <List>
        <ListHeading title="Agents" count={3} />
        <ListRow>
          <Twisty open={open} onToggle={() => setOpen(!open)} />
          <ListRowIcon icon="sparkle" light="working" />
          <ListRowContent title="Review the branch" detail="2 subagents" />
        </ListRow>
        {open && (
          <>
            <ListRow depth={1}>
              <TwistySpace />
              <ListRowIcon icon="sparkle" light="done" />
              <ListRowContent title="Read the diff" />
            </ListRow>
            <ListRow depth={1}>
              <TwistySpace />
              <ListRowIcon icon="sparkle" light="needs" />
              <ListRowContent title="Run the tests" tone="needs" detail="Wants to run pnpm test" />
            </ListRow>
          </>
        )}
      </List>
    </div>
  );
};

/** Mark outside a row (a table's status cell): an icon, the light in its place, a dim one. */
export const Marks = () => (
  <div style={{ display: "flex", gap: "var(--space-4)", alignItems: "center" }}>
    <Mark icon="terminal-window" />
    <Mark icon="terminal-window" light="working" />
    <Mark icon="terminal-window" light="needs" />
    <Mark icon="clock" tone="dim" />
    <Chip hue={30}>side-project</Chip>
    <Chip hue={280} tip="A worktree of cmd">cmd-workbench</Chip>
  </div>
);
