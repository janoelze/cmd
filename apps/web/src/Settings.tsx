// The settings sheet: which Mac this is, how it's reached, what this device may
// do, and Forget This Mac (the Mac keeps listing it until unpaired there).

import { useState } from "react";
import type { Connection, Phase } from "./connection.ts";
import { deviceName, forgetIdentity } from "./identity.ts";
import type { Model } from "./model.ts";
import { Icon, Sheet } from "./ui.tsx";

export function Settings({ conn, phase, model, onClose }: { conn: Connection; phase: Phase; model: Model; onClose: () => void }) {
  const [confirm, setConfirm] = useState(false);
  const address = conn.identity.socket.replace(/^wss?:\/\//, "");
  const status = phase.kind === "online" ? "Connected" : phase.kind === "offline" ? "Offline" : "Connecting…";
  return (
    <Sheet title={model.host} onClose={onClose}>
      <div className="facts">
        <Fact label="Status" value={status} />
        <Fact label="This device" value={deviceName()} />
        <Fact label="Access" value={model.scope === "control" ? "Control: can type and change files" : "View only"} />
        <Fact label="Address" value={address} />
        <div className="fact-note">
          <Icon name="lock" size={13} /> End-to-end encrypted. Anything in between sees only scrambled bytes; your Mac decides who gets in.
        </div>
      </div>
      <div className="sheet-list">
        <button
          className="sheet-item danger"
          onClick={() => {
            if (!confirm) return setConfirm(true);
            conn.close();
            void forgetIdentity().then(() => location.reload());
          }}
        >
          <Icon name="close" />
          <span>
            {confirm ? "Tap again to forget this Mac" : "Forget this Mac"}
            <small>This browser drops its key. Unpair it on the Mac too, in Settings → Remote Access.</small>
          </span>
        </button>
      </div>
    </Sheet>
  );
}

const Fact = ({ label, value }: { label: string; value: string }) => (
  <div className="fact">
    <span>{label}</span>
    <span>{value}</span>
  </div>
);
