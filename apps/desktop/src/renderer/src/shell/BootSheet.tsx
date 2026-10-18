// The sheet over the window while the core does work before it answers (docs/50):
// the first launch of a version updating recorded data, a one-time cleanup. Each
// step of the core's boot report (main/boot.ts sends it) as a row: done, or
// running with its count or what it does now. Shown only once the work has run
// a second (a quick migration doesn't flash it), gone when the core answers.

import { Dialog, Inline, ProgressRing, Separator, Stack, Text } from "@cmd/ui";
import { Fragment, useEffect, useState } from "react";
import type { BootReport, BootStep } from "@cmd/protocol";
import { cmd } from "../lib/bridge.ts";

/** How long boot work runs before the sheet shows. */
export const BOOT_SHEET_MS = 1000;

/** The core's boot report as main last sent it, and since when work has been reported (null: none). */
export function useCoreBoot(): { report: BootReport | null; since: number | null } {
  const [state, setState] = useState<{ report: BootReport | null; since: number | null }>({ report: null, since: null });
  useEffect(() => {
    const take = (r: BootReport | null) => setState((s) => ({ report: r, since: r ? (s.since ?? Date.now()) : null }));
    void cmd.coreBoot().then(take);
    return cmd.onCoreBoot(take);
  }, []);
  return state;
}

/** The core's boot report while it isn't connected and has had work running for BOOT_SHEET_MS; else null. */
export function useBootReport(connected: boolean): BootReport | null {
  const { report, since } = useCoreBoot();
  const [, tick] = useState(0);
  // Once more when the second is up, in case no new report comes before then.
  useEffect(() => {
    if (since === null) return;
    const t = setTimeout(() => tick((n) => n + 1), Math.max(0, since + BOOT_SHEET_MS - Date.now()));
    return () => clearTimeout(t);
  }, [since]);
  if (connected || !report || since === null || Date.now() - since < BOOT_SHEET_MS) return null;
  return report;
}

/** Done: a check. Counting: a ring that fills. Doing one thing it can't count: a ring that turns. */
function Step({ step }: { step: BootStep }) {
  const share = step.total ? Math.min(1, (step.done ?? 0) / step.total) : null;
  return (
    <Inline justify="between">
      <Inline gap={2}>
        <ProgressRing value={share ?? undefined} state={step.ended ? "done" : undefined} label={step.label} />
        <Text>{step.label}</Text>
      </Inline>
      {!step.ended && <Text tone="dim" size="sm">{share !== null ? `${Math.floor(share * 100)}%` : step.detail}</Text>}
    </Inline>
  );
}

export function BootSheet({ open = true, report }: { open?: boolean; report: BootReport }) {
  return (
    <Dialog open={open} onClose={() => {}} dismissable={false} position="center" width={420} window={{ icon: "arrows-clockwise", name: "Getting Ready", close: false }}>
      <Stack gap={8}>
        <Text balance>This version brings your records up to date. It happens once.</Text>
        <Stack gap={3}>
          {report.steps.map((s, i) => (
            <Fragment key={s.id}>
              {i > 0 && <Separator />}
              <Step step={s} />
            </Fragment>
          ))}
        </Stack>
      </Stack>
    </Dialog>
  );
}
