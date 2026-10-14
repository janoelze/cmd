// The grants sheet (docs/56, "Capabilities and grants"): a widget package that wants more than
// the person granted asks once, whatever the number of its windows waiting: its name and
// version, where it comes from, and each permission in words (grants.ts). Allow (Return)
// grants all it asks, never a part of it; Decline (Esc) leaves its windows waiting, with
// Allow… to ask again. The kit's approval sheet (docs/55), dressed for a package, after any
// agent's approval waiting; the core says who is asking (the Library entries' `ask`,
// widgets/host/host.ts asking()).

import { ApprovalSheet, Presence } from "@cmd/ui";
import type { WidgetEntry } from "@cmd/protocol";
import { cmd } from "../../lib/bridge.ts";
import { shortPath } from "../../lib/model.ts";
import { useAsks } from "../../lib/asks.ts";
import { useStoreValue } from "../../lib/store.ts";
import { permissionLines, sourceLine } from "./grants.ts";

/** The first package being asked about (one sheet at a time; the next comes after the answer). */
export function GrantSheets() {
  const asking = useStoreValue((s) => s.library.find((e) => e.source === "package" && e.ask && e.permissions) ?? null);
  // An agent's approval first: one sheet over the window at a time.
  const paused = useAsks().length > 0;
  return <Presence when={paused ? null : asking}>{(e, open) => <GrantSheet key={`${e.name}@${e.version}`} entry={e} open={open} />}</Presence>;
}

const quiet = (p: Promise<unknown>) => void p.catch((err) => console.warn(`widget grant: ${err instanceof Error ? err.message : String(err)}`));

export function GrantSheet({ entry, open = true, onAnswer }: { entry: WidgetEntry; open?: boolean; onAnswer?: (allow: boolean) => void }) {
  const name = entry.name!;
  const granted = entry.ask?.granted ?? null;
  const lines = permissionLines(entry.permissions!, granted);
  const title = granted ? `Allow “${entry.title}” ${entry.version} to use more?` : `Allow “${entry.title}” to use these?`;
  const answer =
    onAnswer ??
    ((allow: boolean) => quiet(allow ? cmd.call("widget.grant", { name }) : cmd.call("widget.ask", { name, decline: true })));
  return (
    <ApprovalSheet
      open={open}
      who={{ icon: entry.icon, name: entry.title, context: `${name} ${entry.version}` }}
      title={title}
      why={sourceLine(entry, shortPath)}
      list={lines.map((l) => ({ icon: l.icon, label: l.label, ...(l.added ? { tag: "New" } : {}) }))}
      allow="Allow"
      deny="Decline"
      askWhy={false}
      onAnswer={(a) => answer(a.allow)}
    />
  );
}
