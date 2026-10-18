// FileDiff with real text: this folder's LiveDiff.tsx as the base and edits of it: a
// small change, a rewrite, a moved block, a new file, two agents on the same lines,
// split, and an agent still writing.

import { useEffect, useRef, useState } from "react";
import { Button, Inline, Separator, Stack, Text } from "@cmd/ui";
import { RefWindow } from "../../reference/RefWindow.tsx";
import { FileDiff, type FileDiffHandle, type FileDiffProps } from "./FileDiff.tsx";
import BASE from "./LiveDiff.tsx?raw";

const PATH = "apps/desktop/src/renderer/src/windows/diff/LiveDiff.tsx";
const edit = (s: string, pairs: [string, string][]) => pairs.reduce((t, [a, b]) => t.replace(a, b), s);

/** A constant and one line of a function (Lark's). */
const SMALL = edit(BASE, [
  ["const POLL_MS = 3000;", "const POLL_MS = 2000;"],
  ["    setTruncated(!!df?.truncated);", "    setTruncated(!!df?.truncated);\n    setUpdated(Date.now());"],
]);
/** The same lines as SMALL, otherwise (Heron's): a clash. */
const OTHER = edit(BASE, [["const POLL_MS = 3000;", "const POLL_MS = 5000; // slower: worktrees add up"]]);
/** The refresh rewritten: a block of new lines for old ones. */
const REWRITE = edit(BASE, [
  [
    BASE.slice(BASE.indexOf("  const refresh = useCallback("), BASE.indexOf("  }, [dir]);") + "  }, [dir]);".length),
    `  const refresh = useCallback(async () => {
    const at = dir;
    // One call for both: the core reads the status and the diff in one git run.
    const r = await cmd.call("git.changes", { path: at }).catch(() => null);
    if (asked.current !== at) return;
    setStatus((prev) => (sameStatus(prev, r?.status) ? prev : (r?.status ?? null)));
    setDiff(r?.diff ?? "");
    setTruncated(!!r?.truncated);
  }, [dir]);`,
  ],
]);
/** The STATE table moved below the component. */
const block = BASE.slice(BASE.indexOf("const STATE: Record"), BASE.indexOf("};\n", BASE.indexOf("const STATE: Record")) + 3);
const MOVED = BASE.replace(block, "").replace("/** A changed file as the list shows it. */", `${block}\n/** A changed file as the list shows it. */`);

function W(p: Partial<FileDiffProps> & { size?: "regular" | "wide" }) {
  const nav = useRef<FileDiffHandle>(null);
  const [place, setPlace] = useState({ count: 0, at: -1 });
  return (
    <RefWindow icon="plus-minus" name="LiveDiff.tsx" size={p.size ?? "regular"}>
      <Stack pad={2}>
      <Inline justify="between">
        <Text size="sm" tone="dim">
          {place.count ? `Change ${Math.max(1, place.at + 1)} of ${place.count}` : "No changes"}
        </Text>
        <Inline gap={1}>
          <Button size="sm" onClick={() => nav.current?.prev()}>Previous</Button>
          <Button size="sm" onClick={() => nav.current?.next()}>Next</Button>
        </Inline>
      </Inline>
      </Stack>
      <Separator />
      <FileDiff ref={nav} path={PATH} before={p.before ?? BASE} after={p.after ?? SMALL} mode={p.mode} others={p.others} onPlace={setPlace} />
    </RefWindow>
  );
}

/** Two small edits in a long file: the rest folds to bars that open it. */
export const SmallEdit = () => <W />;
/** A function rewritten: old lines above, new below, the changed words marked. */
export const Rewrite = () => <W after={REWRITE} />;
/** A block moved: a deletion where it was, an insertion where it went. */
export const Moved = () => <W after={MOVED} />;
/** A new file: everything added. */
export const NewFile = () => <W before="" after={SMALL.split("\n").slice(0, 60).join("\n")} />;
/** Lark's change, with Heron's version of the same lines: the clash is marked orange in the gutter. */
export const Clash = () => <W others={[{ name: "Heron", after: OTHER }]} />;
/** Side by side, when there is room. */
export const Split = () => <W size="wide" mode="split" after={REWRITE} />;

/** An agent still writing: a line more every two seconds, lit as it lands; the view stays where it is. */
export const Live = () => {
  const [after, setAfter] = useState(SMALL);
  const n = useRef(0);
  useEffect(() => {
    const t = setInterval(() => setAfter((a) => a.replace("const OPEN_MAX = 6;", `const OPEN_MAX = 6;\n// note ${++n.current}`)), 2000);
    return () => clearInterval(t);
  }, []);
  return <W after={after} />;
};
