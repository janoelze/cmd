// Live Diff, a built-in widget (docs/16-widgets.md): the uncommitted changes in
// a folder's repository (git.status for the files, git.diff for their lines),
// current as you work: at once when git's index or HEAD changes (stage, commit,
// checkout), and by polling while cmd is in front for edits anywhere below. The
// branch and totals are the title bar's status.

import { Badge, Button, Diff, List, ListRow, Inline, Text, Twisty, View } from "@cmd/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitFile, GitStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { openPath } from "../actions.ts";
import { onFsChanged } from "../store.ts";
import { shortPath } from "../model.ts";
import { stateStr, type WindowViewProps } from "../windows/registry.ts";
import { parseDiff, type FileDiff } from "../diff.ts";
import { useWidgetStatus } from "../widgets.ts";

const POLL_MS = 3000;
/** More files than this start collapsed. */
const OPEN_MAX = 6;

const STATE: Record<GitFile["state"], { letter: string; tone: "success" | "warning" | "danger" | "accent" | "neutral"; tip: string }> = {
  modified: { letter: "M", tone: "warning", tip: "Modified" },
  added: { letter: "A", tone: "success", tip: "Added" },
  untracked: { letter: "U", tone: "success", tip: "New, not yet added" },
  deleted: { letter: "D", tone: "danger", tip: "Deleted" },
  renamed: { letter: "R", tone: "accent", tip: "Renamed" },
  conflict: { letter: "!", tone: "danger", tip: "Conflict" },
  ignored: { letter: "I", tone: "neutral", tip: "Ignored" },
};

export function LiveDiff({ win }: WindowViewProps) {
  const dir = stateStr(win, "path") ?? "";
  const [status, setStatus] = useState<GitStatus | null | undefined>(undefined);
  const [diff, setDiff] = useState("");
  const [truncated, setTruncated] = useState(false);
  /** Files the person opened or closed (others follow OPEN_MAX). */
  const [toggled, setToggled] = useState<Map<string, boolean>>(new Map());
  const [extra, setExtra] = useState<Map<string, string>>(new Map());
  const asked = useRef(dir);
  asked.current = dir;

  const refresh = useCallback(async () => {
    const at = dir;
    const [st, df] = await Promise.all([cmd.call("git.status", { path: at }).catch(() => null), cmd.call("git.diff", { path: at }).catch(() => null)]);
    if (asked.current !== at) return;
    // Polling mostly finds nothing new: keep the same values so nothing re-renders.
    setStatus((prev) => (JSON.stringify(prev) === JSON.stringify(st) ? prev : st));
    setDiff(df?.diff ?? "");
    setTruncated(!!df?.truncated);
  }, [dir]);

  useEffect(() => {
    setStatus(undefined);
    setExtra(new Map());
    void refresh();
    const poll = setInterval(() => document.hasFocus() && void refresh(), POLL_MS);
    window.addEventListener("focus", refresh);
    return () => {
      clearInterval(poll);
      window.removeEventListener("focus", refresh);
    };
  }, [refresh]);

  const gitDir = status?.gitDir;
  useEffect(() => {
    if (!gitDir) return;
    const files = ["index", "HEAD", "logs/HEAD"].map((f) => `${gitDir}/${f}`);
    for (const f of files) void cmd.call("fs.watch", { path: f }).catch(() => {});
    const off = onFsChanged((p) => files.includes(p) && void refresh());
    return () => {
      off();
      for (const f of files) void cmd.call("fs.unwatch", { path: f }).catch(() => {});
    };
  }, [gitDir, refresh]);

  const byFile = useMemo(() => parseDiff(diff), [diff]);
  const files = useMemo(
    () =>
      Object.entries(status?.files ?? {})
        .filter(([, f]) => f.state !== "ignored")
        .map(([abs, f]) => ({ abs, rel: status ? abs.slice(status.root.length + 1) : abs, file: f }))
        .sort((a, b) => a.rel.localeCompare(b.rel)),
    [status],
  );

  // Untracked files have no lines in the diff: ask for each one opened.
  const isOpen = (rel: string) => toggled.get(rel) ?? files.length <= OPEN_MAX;
  useEffect(() => {
    for (const f of files) {
      if (f.file.state !== "untracked" || !isOpen(f.rel) || extra.has(f.rel) || f.abs.endsWith("/")) continue;
      void cmd.call("git.diff", { path: dir, file: f.abs }).then(
        (r) => setExtra((m) => new Map(m).set(f.rel, r?.diff ?? "")),
        () => setExtra((m) => new Map(m).set(f.rel, "")),
      );
    }
  }, [files, toggled]); // eslint-disable-line react-hooks/exhaustive-deps

  const diffOf = (rel: string, state: GitFile["state"]): FileDiff | undefined => (state === "untracked" ? parseDiff(extra.get(rel) ?? "").get(rel) : byFile.get(rel));
  const totals = files.reduce((t, f) => {
    const d = diffOf(f.rel, f.file.state);
    return { added: t.added + (d?.added ?? 0), removed: t.removed + (d?.removed ?? 0) };
  }, { added: 0, removed: 0 });

  // The title bar's status: the branch, how far from its upstream, what changed.
  const branch = status ? `${status.branch ?? status.head ?? "no commits"}${status.ahead ? ` ↑${status.ahead}` : ""}${status.behind ? ` ↓${status.behind}` : ""}` : null;
  const changed = files.length ? [`${files.length} ${files.length === 1 ? "file" : "files"}`, totals.added || totals.removed ? `+${totals.added} −${totals.removed}` : ""].filter(Boolean).join(" ") : "no changes";
  useWidgetStatus(win.id, branch && `${branch} · ${changed}`, "summary");

  const choose = async () => {
    const p = await cmd.chooseFolder();
    if (p) void cmd.call("window.update", { id: win.id, state: { path: p } }).catch(() => {});
  };

  const shown: DiffFile[] = files.map(({ abs, rel, file }) => {
    const d = diffOf(rel, file.state);
    return {
      abs,
      rel,
      state: file.state,
      staged: !!file.staged,
      added: d?.added ?? 0,
      removed: d?.removed ?? 0,
      open: isOpen(rel),
      lines: d && !d.binary ? d.lines : undefined,
      note: d?.binary ? "Binary file" : !d && file.state !== "untracked" && file.state !== "deleted" ? "No line changes (mode or rename only)" : undefined,
    };
  });
  return (
    <LiveDiffView
      state={status === undefined ? "loading" : status === null ? "noRepo" : "ok"}
      dir={dir}
      files={shown}
      truncated={truncated}
      onToggle={(rel, open) => setToggled((m) => new Map(m).set(rel, open))}
      onOpen={(abs) => void openPath(abs)}
      onChoose={() => void choose()}
    />
  );
}

/** A changed file as the list shows it. */
export interface DiffFile {
  abs: string;
  rel: string;
  state: GitFile["state"];
  staged: boolean;
  added: number;
  removed: number;
  open: boolean;
  /** Its diff's lines, when it has some to show. */
  lines?: readonly string[];
  /** In place of lines: binary, or nothing but a mode change. */
  note?: string;
}

/** The changes, drawn (LiveDiff.story.tsx shows every state). */
export function LiveDiffView(p: { state: "loading" | "noRepo" | "ok"; dir: string; files: DiffFile[]; truncated: boolean; onToggle: (rel: string, open: boolean) => void; onOpen: (abs: string) => void; onChoose: () => void }) {
  return (
    <View
      state={
        p.state === "loading"
          ? { kind: "loading" }
          : p.state === "noRepo"
            ? { kind: "empty", icon: "plusminus", title: "Not in a Git repository", text: shortPath(p.dir), action: <Button onClick={p.onChoose}>Choose Folder…</Button> }
            : !p.files.length
              ? { kind: "empty", icon: "checkmark.circle", title: "Nothing uncommitted", text: shortPath(p.dir) }
              : null
      }
    >
      <List>
        {p.files.map((f) => {
          const st = STATE[f.state];
          const what = `${st.tip}${f.staged ? ", staged" : ""}`;
          return (
            <div key={f.abs} role="group" aria-label={f.rel}>
              <ListRow
                lead={<Twisty open={f.open} onToggle={() => p.onToggle(f.rel, !f.open)} />}
                icon={
                  <Badge size="sm" tone={st.tone} tip={what}>
                    {st.letter}
                  </Badge>
                }
                title={f.rel.replace(/\/$/, "").split("/").pop()}
                place={f.rel.includes("/") ? f.rel.replace(/\/?[^/]+\/?$/, "") : undefined}
                tip={`${f.rel}\nDouble-click to open`}
                end={
                  <Inline gap="sm">
                    {f.added > 0 && (
                      <Text size="xs" mono tone="success">
                        +{f.added}
                      </Text>
                    )}
                    {f.removed > 0 && (
                      <Text size="xs" mono tone="danger">
                        −{f.removed}
                      </Text>
                    )}
                  </Inline>
                }
                onClick={() => p.onToggle(f.rel, !f.open)}
                onDoubleClick={() => p.onOpen(f.abs)}
              />
              {f.open && (f.note ? <Diff note={f.note} /> : f.lines?.length ? <Diff lines={f.lines} /> : null)}
            </div>
          );
        })}
        {p.truncated && <Diff note="The diff is too large to show in full." />}
      </List>
    </View>
  );
}
