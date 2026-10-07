// Settings → Notifications → macOS: whether macOS shows cmd's notifications at
// all, with a way to turn them on (its prompt, or System Settings at cmd's page)
// and a test notification (main/notify-permission.ts). Looks again whenever the
// window gets focus, so coming back from System Settings shows the change.

import { useEffect, useState } from "react";
import { Button, FormRow, FormSection } from "@cmd/ui";
import { cmd } from "../bridge.ts";

type Permission = Awaited<ReturnType<typeof cmd.notifyPermission>>;

const FOCUS_INFO = "A Focus, like Do Not Disturb, can still hold them back. Send a test to check.";

export function NotifyPermission() {
  const [p, setP] = useState<Permission>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    const look = () => void cmd.notifyPermission().then(setP, () => {});
    look();
    window.addEventListener("focus", look);
    return () => window.removeEventListener("focus", look);
  }, []);
  if (!p) return null;

  const turnOn = () => {
    setBusy(true);
    cmd
      .requestNotifyPermission()
      .then(setP, () => {})
      .finally(() => setBusy(false));
  };
  const test = <Button onClick={() => cmd.sendTestNotification()}>Send Test</Button>;
  const open = (primary: boolean) => (
    <Button variant={primary ? "primary" : undefined} onClick={() => cmd.openNotifySettings()}>
      Open System Settings
    </Button>
  );

  return (
    <FormSection title="macOS">
      {p.access === "on" && (
        <FormRow title="Notifications are on" description="macOS shows cmd's notifications." info={FOCUS_INFO}>
          {test}
        </FormRow>
      )}
      {p.access === "ask" && (
        <FormRow title="Notifications aren't on yet" description="macOS asks once whether cmd may show them.">
          <Button variant="primary" disabled={busy} onClick={turnOn}>
            Turn On…
          </Button>
        </FormRow>
      )}
      {p.access === "quiet" && (
        <FormRow
          title="Notifications are quiet"
          description="They go to Notification Center without a banner."
          note="Set cmd's alert style to Banners in System Settings."
          noteTone="warning"
        >
          {test}
          {open(false)}
        </FormRow>
      )}
      {p.access === "off" && (
        <FormRow
          title="Notifications are off"
          description="You won't hear when an agent is done or needs you."
          note="Turn on Allow Notifications for cmd in System Settings."
          noteTone="danger"
        >
          {open(true)}
        </FormRow>
      )}
    </FormSection>
  );
}
