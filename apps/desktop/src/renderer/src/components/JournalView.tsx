// The Journal widget's window view: fetches the days Journal draws. What's
// written shows at once (journal.days without writing); then the core writes
// what changed since, which takes a model a few seconds, under a "Writing…"
// line. Write Again rewrites today. Every 15 minutes it looks again, and when
// AI gets set up. Without AI nothing is written: it says how to set it up.

import { useCallback, useEffect, useRef, useState } from "react";
import type { JournalDay } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { useAiStatus } from "../ai/status.ts";
import { scopeOf } from "../widgets.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import { Journal } from "./Journal.tsx";

const DAYS = 7;
const REFRESH_MS = 15 * 60_000;

export function JournalView({ win }: WindowViewProps) {
  const scope = scopeOf(win.state.scope);
  const ai = useAiStatus();
  const needsAi = ai !== null && !ai.ready;
  const [days, setDays] = useState<JournalDay[] | null>(null);
  const [writing, setWriting] = useState(false);
  const gen = useRef(0);
  const params = scope === "all" ? { scope: "all" } : { spaceId: win.spaceId };

  const load = useCallback(
    async (write: "stale" | "force") => {
      const g = ++gen.current;
      const ok = (d: JournalDay[]) => g === gen.current && setDays(d);
      try {
        ok(await cmd.call("journal.days", { ...params, count: DAYS, write: "never" }));
        setWriting(true);
        if (write === "force") await cmd.call("journal.day", { ...params, date: Date.now(), write: "force" });
        ok(await cmd.call("journal.days", { ...params, count: DAYS, write: "stale" }));
      } catch {
        // an older core, or none: what's shown stays
      } finally {
        if (g === gen.current) setWriting(false);
      }
    },
    [scope, win.spaceId, needsAi],
  );

  useEffect(() => {
    setDays(null);
    void load("stale");
    const t = setInterval(() => void load("stale"), REFRESH_MS);
    return () => clearInterval(t);
  }, [load]);

  const repos = new Set((days ?? []).flatMap((d) => d.entries.map((e) => e.repo)));
  return <Journal days={days ?? []} showProject={scope === "all" || repos.size > 1} summarising={days === null ? "Reading the journal…" : writing ? "Writing up what happened…" : null} onRefresh={needsAi ? undefined : () => void load("force")} onSetUpAi={needsAi ? () => cmd.openSettings("ai") : undefined} />;
}
