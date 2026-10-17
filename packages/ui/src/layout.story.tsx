// Content pieces as sheets, settings and views use them: a setup's Checklist, what something
// offers (SheetHeader and FeatureList), facts in KeyValue, running text in Prose; the
// Settings layout (FormSection, FormRow, ResetButton, InfoButton, FormActions, Group);
// Callouts and EmptyStates; a Diff; a QrCode; a Toolbar with its Separator and Spacer;
// a JumpButton over a scroller.
import { useState } from "react";
import { renderSVG } from "uqr";
import { Badge, Kbd } from "./status.tsx";
import { Button, ButtonGroup, IconButton, JumpButton, LinkButton } from "./button.tsx";
import { Segmented, Switch } from "./choice.tsx";
import { NumberField, SecretField, TextArea, TextField } from "./fields.tsx";
import { Callout, Card, Checklist, Diff, EmptyState, FeatureList, FormActions, FormRow, FormSection, Group, InfoButton, KeyValue, PageIntro, Prose, QrCode, ResetButton, SectionHeading, Separator, SheetHeader, Spacer, Toolbar } from "./layout.tsx";

/** A setup's steps, titled as things to do: done ones are a line with their value, the first that isn't shows what to do and a way to check again, the rest wait. */
export const Setup = () => (
  <div style={{ width: 480 }}>
    <Checklist
      steps={[
        { title: "Install Tailscale", state: "done" },
        { title: "Connect to your tailnet", state: "done", detail: "lukas@github" },
        {
          title: "Turn on HTTPS certificates",
          state: "todo",
          detail: "In Tailscale's admin console, under DNS.",
          action: (
            <>
              <Button>Open Admin Console</Button>
              <Button variant="ghost">Check Again</Button>
            </>
          ),
        },
        { title: "Publish on your tailnet", state: "todo" },
      ]}
    />
  </div>
);

/** A step that failed: what went wrong, and its fix. */
export const Failed = () => (
  <div style={{ width: 480 }}>
    <Checklist
      steps={[
        { title: "Install Tailscale", state: "done" },
        { title: "Connect to your tailnet", state: "failed", detail: "tailscale status: not logged in", action: <Button>Log In</Button> },
        { title: "Publish on your tailnet", state: "todo" },
      ]}
    />
  </div>
);

/** A sheet's greeting, then what it offers, one feature a line. */
export const Offer = () => (
  <div style={{ display: "flex", flexDirection: "column", gap: 12, width: 460 }}>
    <Card>
      <SheetHeader icon="sparkles" title="Connect an AI provider" subtitle="Magic widgets and notification summaries use it." />
    </Card>
    <Card>
      <FeatureList
        items={[
          { icon: "rectangle.3.group", title: "A workspace per project", description: "Terminals, agents, a browser and an editor as windows." },
          { icon: "terminal", title: "Agents in your terminals", description: "The one that needs you is on top." },
        ]}
      />
    </Card>
  </div>
);

/** Facts as label and value; mono for data (a widget's permissions). */
/** A settings page's intro: what the feature is and where it shows up, above its sections. */
export const Intro = () => (
  <div style={{ width: 560 }}>
    <PageIntro icon="bolt.fill" links={<LinkButton onClick={() => {}}>Edit quick-commands.json…</LinkButton>}>
      Save the commands and prompts you type every day. Run them from Session → Quick Commands, the palette, a shortcut or <code>cmd quick run</code>.
    </PageIntro>
    <FormSection title="Quick Commands">
      <FormRow title="Push Branch" description="Type · git push -u origin {{branch}}" />
    </FormSection>
  </div>
);

export const Facts = () => (
  <div style={{ display: "flex", gap: 24, width: 560 }}>
    <KeyValue
      mono
      items={[
        ["Network", "api.open-meteo.com"],
        ["Files", "none"],
        ["Env", "OPENWEATHER_KEY"],
      ]}
    />
    <KeyValue
      items={[
        ["Build", "4f670fc"],
        ["Uptime", "3h 12m"],
        ["Terminals", "7"],
      ]}
    />
  </div>
);

/** Release notes: running text styled by its elements (h3 with a date, lists, code, links). */
export const Notes = () => (
  <div style={{ width: 460 }}>
    <Card>
      <Prose>
        <h3>
          0.14.0 <small>5 October 2026</small>
        </h3>
        <p>Read PDFs in cmd, and four new built-in widgets.</p>
        <Badge size="sm" tone="success">
          Improved
        </Badge>
        <ul>
          <li>
            <strong>Built-in widgets.</strong> Commands lists what your terminals ran; <code>cmd open</code> opens files.
          </li>
          <li>
            Window outlines no longer spill into the gap. <a href="#">Read more</a>
          </li>
        </ul>
      </Prose>
    </Card>
  </div>
);

/** The Settings window's layout: sections of rows, text left and controls lined up right; info behind a button, a reset once changed, a note, a stacked row; buttons under it. */
export const Settings = () => {
  const [s, setS] = useState({ notify: true, appearance: "auto", font: 14, shell: "/bin/zsh" });
  const set = <K extends keyof typeof s>(k: K, v: (typeof s)[K]) => setS({ ...s, [k]: v });
  return (
    <div style={{ width: 620, display: "flex", flexDirection: "column", gap: "var(--space-5)" }}>
      <FormSection title="General">
        <FormRow title="Notifications" description="When an agent finishes or needs you." info="Only while its window isn't in front. Attention markers show either way." tip="notify.enabled">
          <Switch checked={s.notify} onChange={(v) => set("notify", v)} label="Notifications" />
        </FormRow>
        <FormRow title="Appearance" accessory={s.appearance !== "auto" && <ResetButton onClick={() => set("appearance", "auto")} />}>
          <Segmented value={s.appearance} onChange={(v) => set("appearance", v)} options={["auto", "dark", "light"]} labels={{ auto: "Auto", dark: "Dark", light: "Light" }} />
        </FormRow>
        <FormRow title="Font size" description="Terminals and the editor." accessory={<Badge size="sm" tone="accent">New</Badge>}>
          <NumberField value={s.font} min={8} max={32} unit="px" onChange={(v) => set("font", v)} />
        </FormRow>
        <FormRow title="Shell" description="Applies to new terminals." note={s.shell.includes(" ") ? "Paths with spaces need quoting." : undefined} noteTone="warning">
          <TextField code value={s.shell} onCommit={(v) => set("shell", v)} />
        </FormRow>
      </FormSection>
      <FormSection title="Widget" aside={<LinkButton>Reset all</LinkButton>}>
        <FormRow title="API key" description="Stored in the macOS keychain, not in settings.json.">
          <SecretField set hint="…9c2e" onSave={() => {}} />
        </FormRow>
        <FormRow title="Prompt" description="Stacked: the control under the text, full width." stacked>
          <TextArea value="" onChange={() => {}} placeholder="Anything the widget should know" rows={2} />
        </FormRow>
      </FormSection>
      <FormSection title="Shortcuts">
        {[
          ["New Terminal", "⌘T"],
          ["Command Palette", "⌘K"],
        ].map(([t, k]) => (
          <FormRow key={t} compact title={t}>
            <Kbd keys={k!} />
          </FormRow>
        ))}
      </FormSection>
      <FormActions hint="Buttons under a section, a hint at the left.">
        <Button>Restore Defaults</Button>
      </FormActions>
    </div>
  );
};

/** A group box with your own heading, and an info button on its own (a rich tooltip on hover or focus). */
export const Groups = () => (
  <div style={{ width: 420, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
    <SectionHeading aside={<InfoButton>Widgets you made with Magic, and the built-in ones. Right-click one to rename or delete it.</InfoButton>}>Library</SectionHeading>
    <Group>
      <FormRow title="Weather" compact>
        <Badge size="sm">Magic</Badge>
      </FormRow>
      <FormRow title="Commands" compact>
        <Badge size="sm">Built-in</Badge>
      </FormRow>
    </Group>
  </div>
);

/** Above content: something failed, needs doing or is worth knowing; and full width along a view's edge (banner). */
export const Callouts = () => {
  const [shown, setShown] = useState(true);
  return (
    <div style={{ width: 520, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
      {shown ? (
        <Callout tone="danger" title="The data isn't coming" actions={<Button size="sm">Fix</Button>} onDismiss={() => setShown(false)}>
          fetch https://api.open-meteo.com failed 3 times in a row: 503 Service Unavailable.
        </Callout>
      ) : (
        <Button size="sm" onClick={() => setShown(true)}>
          Show again
        </Button>
      )}
      <Callout tone="warning" actions={<LinkButton>Reload</LinkButton>}>
        This file changed on disk since you opened it.
      </Callout>
      <Callout tone="success">All checks passed.</Callout>
      <Callout tone="accent" title="Tip">
        ⌘E switches between a widget and its editor.
      </Callout>
      <div style={{ borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
        <Callout banner tone="warning" actions={<Button size="sm">Reload</Button>}>
          notes.md changed on disk.
        </Callout>
        <div style={{ height: 48, background: "var(--well)" }} />
        <Callout banner="bottom" compact tone="danger" actions={<LinkButton>Details</LinkButton>}>
          Data keeps failing: fetch failed (503)
        </Callout>
      </div>
    </div>
  );
};

/** Nothing here yet: what goes here and how to start; compact in a smaller place. */
export const Empty = () => (
  <div style={{ width: 420, display: "flex", flexDirection: "column", gap: "var(--space-4)" }}>
    <EmptyState icon="safari" title="Blank page" action={<Button>Open a URL</Button>}>
      Type an address, or drop a link here.
    </EmptyState>
    <Separator />
    <EmptyState compact icon="clock.arrow.circlepath" title="No versions yet">
      Each change you ask for is kept here, so you can go back.
    </EmptyState>
  </div>
);

/** A file's changes under its row (Live Diff): hunks, additions, deletions; and a note in place of lines. */
export const Changes = () => (
  <div style={{ width: 520, display: "flex", flexDirection: "column", gap: "var(--space-3)" }}>
    <Diff lines={["@@ -12,6 +12,7 @@ export function Button(", "   variant = \"default\",", "-  size = \"md\",", "+  size = \"sm\",", "+  busy,", "   icon,"]} />
    <Diff note="Binary file" />
  </div>
);

/** A file's whole diff in a pane of its own (fill): it takes the pane's height and scrolls both ways, scrollbars at the pane's edges. */
export const ChangesInAPane = () => (
  <div style={{ width: 360, height: 160, display: "flex", flexDirection: "column", background: "var(--well)" }}>
    <Diff fill lines={["@@ -12,6 +12,7 @@ export function Button(", ...Array.from({ length: 12 }, (_, i) => `+  option${i}: "a long line that runs past the pane's right edge, so it scrolls sideways",`), "   icon,"]} />
  </div>
);

/** A pairing link as a camera reads it, on white in any theme. */
export const Qr = () => (
  <div style={{ width: 200 }}>
    <QrCode svg={renderSVG("https://cmd.example/pair#k3c9-x8", { ecc: "L", border: 2, pixelSize: 6 })} />
  </div>
);

/** A bar of controls: a joined pair, a field that fills, a separator between groups, the rest pushed to the end. */
export const Bar = () => (
  <div style={{ width: 560, borderRadius: "var(--radius-md)", overflow: "hidden", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
    <Toolbar>
      <ButtonGroup joined>
        <IconButton variant="default" icon="chevron.left" label="Back" />
        <IconButton variant="default" icon="chevron.right" label="Forward" />
      </ButtonGroup>
      <IconButton icon="arrow.clockwise" label="Reload" shortcut="⌘R" />
      <TextField value="https://github.com/janoelze/cmd" fill onChange={() => {}} size="sm" />
      <Separator vertical />
      <Spacer />
      <IconButton icon="arrow.up.forward.app" label="Open in Browser" />
    </Toolbar>
    <div style={{ height: 48, background: "var(--well)" }} />
  </div>
);

/** A scroller away from its end: the JumpButton floats in its corner, with a dot once something new arrived. Tap it to toggle the dot; Hide shows it leaving. */
export const Jump = () => {
  const [unread, setUnread] = useState(true);
  const [open, setOpen] = useState(true);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-2)", width: 320 }}>
      <div style={{ position: "relative", height: 160, borderRadius: "var(--radius-md)", background: "var(--well)", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
        <div style={{ position: "absolute", right: "var(--space-3)", bottom: "var(--space-3)" }}>
          <JumpButton open={open} unread={unread} onClick={() => setUnread(!unread)} />
        </div>
      </div>
      <Button onClick={() => setOpen(!open)}>{open ? "Hide" : "Show"}</Button>
    </div>
  );
};
