// Live Diff, a built-in widget (docs/16-widgets.md): the uncommitted changes in
// a folder's repository (git.status for the files, git.diff for their lines),
// current as you work: at once when git's index or HEAD changes (stage, commit,
// checkout), and by polling while cmd is in front for edits anywhere below.

import { Badge, Button, EmptyState } from "@cmd/ui";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GitFile, GitStatus } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { openPath } from "../actions.ts";
import { onFsChanged } from "../store.ts";
import { shortPath } from "../model.ts";
import { stateStr, type WindowViewProps } from "../windows/registry.ts";
import { parseDiff, type FileDiff } from "../diff.ts";
import { Symbol } from "./Symbol.tsx";
import "./widgets.css";

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

  const choose = async () => {
    const p = await cmd.chooseFolder();
    if (p) void cmd.call("window.update", { id: win.id, state: { path: p } }).catch(() => {});
  };

  if (status === undefined) return <div className="ld" />;
  if (status === null)
    return (
      <div className="ld">
        <EmptyState icon="plusminus" title="Not in a Git repository" action={<Button onClick={() => void choose()}>Choose Folder…</Button>}>
          {shortPath(dir)}
        </EmptyState>
      </div>
    );
  return (
    <div className="ld">
      <div className="ld-bar">
        <span className="ld-branch">
          <Symbol name="arrow.triangle.branch" size={12} />
          {status.branch ?? status.head ?? "no commits"}
          {status.ahead > 0 && <span className="ld-ab">↑{status.ahead}</span>}
          {status.behind > 0 && <span className="ld-ab">↓{status.behind}</span>}
        </span>
        <span className="ld-summary">
          {files.length ? `${files.length} ${files.length === 1 ? "file" : "files"}` : "No changes"}
          {totals.added > 0 && <span className="ld-plus">+{totals.added}</span>}
          {totals.removed > 0 && <span className="ld-minus">−{totals.removed}</span>}
        </span>
      </div>
      <div className="ld-list">
        {!files.length && (
          <EmptyState compact icon="checkmark.circle.fill" title="Nothing uncommitted">
            {shortPath(dir)}
          </EmptyState>
        )}
        {files.map(({ abs, rel, file }) => {
          const d = diffOf(rel, file.state);
          const open = isOpen(rel);
          const st = STATE[file.state];
          return (
            <section key={abs} className="ld-file">
              <div
                className="ld-file-head"
                role="button"
                onClick={() => setToggled((m) => new Map(m).set(rel, !open))}
                onDoubleClick={() => void openPath(abs)}
                data-tip="Double-click to open"
              >
                <span className={`ld-twisty ${open ? "open" : ""}`}>
                  <Symbol name="chevron.right" size={10} />
                </span>
                <Badge size="sm" tone={st.tone} tip={`${st.tip}${file.staged ? ", staged" : ""}`}>
                  {st.letter}
                </Badge>
                <span className="ld-path">{rel}</span>
                <span className="ld-counts">
                  {!!d?.added && <span className="ld-plus">+{d.added}</span>}
                  {!!d?.removed && <span className="ld-minus">−{d.removed}</span>}
                </span>
              </div>
              {open && d && !d.binary && d.lines.length > 0 && (
                <pre className="ld-hunks">
                  {d.lines.map((l, i) => (
                    <div key={i} className="ld-line" data-kind={l.startsWith("@@") ? "hunk" : l[0] === "+" ? "add" : l[0] === "-" ? "del" : undefined}>
                      {l || " "}
                    </div>
                  ))}
                </pre>
              )}
              {open && d?.binary && <div className="ld-note">Binary file</div>}
              {open && !d && file.state !== "untracked" && file.state !== "deleted" && <div className="ld-note">No line changes (mode or rename only)</div>}
            </section>
          );
        })}
        {truncated && <div className="ld-note">The diff is too large to show in full.</div>}
      </div>
    </div>
  );
}
