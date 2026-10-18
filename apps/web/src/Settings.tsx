// The settings sheet: which Mac this is, how it's reached, what this device may
// do, its notifications from this Mac, the paired Macs to switch between, Add a Mac, and Forget This Mac (the
// Mac keeps listing it until unpaired there). MacsSheet is the list alone, for
// when the Mac isn't connected.

import { useEffect, useState } from "react";
import { Button, Callout, Dialog, Icon, KeyValue, ListRow, ListRowContent, ListRowEnd, ListRowIcon, ListSection, Switch } from "@cmd/ui";
import type { Connection, Phase } from "./connection.ts";
import { deviceName, listMacs, type Mac } from "./identity.ts";
import type { Model } from "./model.ts";
import type { PushState } from "./push.ts";
import { ago } from "./ui.tsx";

interface MacActions {
  onAdd: () => void;
  onSwitch: (key: string) => void;
  onForget: () => void;
}

export function Settings({
  open,
  conn,
  phase,
  model,
  push,
  onPush,
  onClose,
  onAdd,
  onSwitch,
  onForget,
}: { open: boolean; conn: Connection; phase: Phase; model: Model; push: PushState | null; onPush: (on: boolean) => void; onClose: () => void } & MacActions) {
  const [confirm, setConfirm] = useState(false);
  const address = conn.identity.socket.replace(/^wss?:\/\//, "");
  const status = phase.kind === "online" ? "Connected" : phase.kind === "offline" ? "Offline" : "Connecting…";
  const close = () => (setConfirm(false), onClose());
  return (
    <Dialog open={open} onClose={close} title={model.host} label="Settings">
      <KeyValue
        items={[
          ["Status", status],
          ["This device", deviceName()],
          ["Access", model.scope === "control" ? "Control: can type and change files" : "View only"],
          ["Address", address],
        ]}
      />
      <Callout icon="lock">End-to-end encrypted. Anything in between sees only scrambled bytes; your Mac decides who gets in.</Callout>
      {push && (
        <ListSection title="Notifications">
          <ListRow>
            <ListRowIcon icon="bell" />
            <ListRowContent title="Notifications" detail={PUSH_DETAIL[push]} />
            <ListRowEnd>
              <Switch checked={push === "on"} disabled={push !== "on" && push !== "off"} label="Notifications" onChange={onPush} />
            </ListRowEnd>
          </ListRow>
        </ListSection>
      )}
      {open && <MacList current={conn.key} currentName={model.host} onAdd={onAdd} onSwitch={onSwitch} />}
      <Button
        size="lg"
        variant="danger"
        icon="x"
        onClick={() => {
          if (!confirm) return setConfirm(true);
          onForget();
        }}
      >
        {confirm ? "Tap Again to Forget" : "Forget This Mac"}
      </Button>
      <p className="note">This browser drops its key. Unpair it on the Mac too, in Settings → Remote Access.</p>
    </Dialog>
  );
}

/** The paired Macs, for when this one isn't connected (offline, unpaired). */
export function MacsSheet({ open, current, currentName, onAdd, onSwitch, onClose }: { open: boolean; current: string; currentName?: string; onClose: () => void } & Omit<MacActions, "onForget">) {
  return (
    <Dialog open={open} onClose={onClose} title="Macs" label="Macs">
      {open && <MacList current={current} currentName={currentName} onAdd={onAdd} onSwitch={onSwitch} />}
    </Dialog>
  );
}

/** Every paired Mac, the current one ticked; tap another to switch. Then Add a Mac. */
function MacList({ current, currentName, onAdd, onSwitch }: { current: string; currentName?: string; onAdd: () => void; onSwitch: (key: string) => void }) {
  const [macs, setMacs] = useState<Mac[]>([]);
  useEffect(() => {
    void listMacs().then(setMacs, () => {});
  }, []);
  return (
    <div className="macs">
      <ListSection title="Macs" count={macs.length}>
        {macs.map((m) => {
          const here = m.key === current;
          return (
            <ListRow
              key={m.key}
              selected={here}
              aria-current={here || undefined}
              onClick={() => onSwitch(m.key)}
            >
              <ListRowIcon icon="laptop" />
              <ListRowContent title={here ? (currentName ?? m.name) : m.name} detail={here ? "Open now" : used(m.lastUsed)} />
              <ListRowEnd>{here ? <Icon name="check" /> : undefined}</ListRowEnd>
            </ListRow>
          );
        })}
        <ListRow onClick={onAdd}>
          <ListRowIcon icon="plus" />
          <ListRowContent title="Add a Mac" />
        </ListRow>
      </ListSection>
    </div>
  );
}

const PUSH_DETAIL: Record<PushState, string> = {
  on: "When your Mac notifies you",
  off: "Off",
  denied: "Blocked in this browser's settings",
  install: "Add cmd to your Home Screen first",
  unsupported: "This browser can't show them",
  old: "Update cmd on your Mac first",
};

const used = (t: number) => {
  if (!t) return "Not opened yet";
  const a = ago(t);
  return a === "now" ? "Opened just now" : `Opened ${a} ago`;
};
