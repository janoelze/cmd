// Unified diffs (git.diff) by file, for Live Diff (components/LiveDiff.tsx).

export interface FileDiff {
  /** Repository-relative path (the new one for renames). */
  path: string;
  lines: string[];
  added: number;
  removed: number;
  binary: boolean;
}

/** A unified diff (`diff --git a/x b/x` sections) by file. */
export function parseDiff(text: string): Map<string, FileDiff> {
  const out = new Map<string, FileDiff>();
  for (const part of text.split(/^diff --git /m).slice(1)) {
    const lines = part.split("\n");
    const plus = lines.find((l) => l.startsWith("+++ "));
    const minus = lines.find((l) => l.startsWith("--- "));
    const header = /^a\/(.*) b\/(.*)$/.exec(lines[0]!);
    const target = plus && plus !== "+++ /dev/null" ? plus.slice(6) : minus && minus !== "--- /dev/null" ? minus.slice(6) : (header?.[2] ?? lines[0]!);
    const at = lines.findIndex((l) => l.startsWith("@@"));
    const body = at < 0 ? [] : lines.slice(at).filter((l, i, all) => !(i === all.length - 1 && l === ""));
    out.set(target, {
      path: target,
      lines: body,
      added: body.filter((l) => l.startsWith("+")).length,
      removed: body.filter((l) => l.startsWith("-")).length,
      binary: lines.some((l) => l.startsWith("Binary files")),
    });
  }
  return out;
}
