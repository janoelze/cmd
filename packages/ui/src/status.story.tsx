// Status as the app shows it: keys (Kbd), pages (PageDots), progress (bars, rings,
// spinners), and LiveBadge, a device watching a window with a note of what it did.
import { useEffect, useState } from "react";
import { Kbd, LiveBadge, PageDots, Progress, ProgressRing, Spinner } from "./status.tsx";

/** Shortcuts as keys, joined or as one string, and plain (inside a menu). */
export const Keys = () => (
  <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
    <Kbd keys={["⌘", "K"]} />
    <Kbd keys="⌘⇧P" />
    <Kbd keys="⌘E" plain />
  </div>
);

/** Pages: a dot each, the current a wider pill; with onSelect the dots are buttons. */
export const Pages = () => {
  const [at, setAt] = useState(1);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-3)", alignItems: "flex-start" }}>
      <PageDots count={5} current={at} onSelect={setAt} />
      <PageDots count={8} current={at} onSelect={setAt} size="sm" />
      <PageDots count={3} current={at % 3} />
    </div>
  );
};

/** Bars, rings and spinners; the first of each runs. */
export const Progresses = () => {
  const [p, setP] = useState(0.35);
  useEffect(() => {
    const t = setInterval(() => setP((v) => (v >= 1 ? 0 : v + 0.05)), 300);
    return () => clearInterval(t);
  }, []);
  return (
    <div style={{ display: "flex", flexDirection: "column", gap: "var(--space-4)", width: 420 }}>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
        <Progress value={p} />
        <Progress value={0.7} tone="success" />
        <Progress value={0.4} tone="danger" />
        <Progress label="Indexing" />
      </div>
      <div style={{ display: "flex", gap: "var(--space-3)", alignItems: "center" }}>
        <ProgressRing value={p} />
        <ProgressRing value={0.75} size={18} />
        <ProgressRing label="Working" />
        <ProgressRing state="done" label="Done" />
        <ProgressRing state="failed" label="Failed" />
        <Spinner />
        <Spinner size={16} />
        <span style={{ display: "flex", gap: "var(--space-1-5)", alignItems: "center", color: "var(--text-dim)" }}>
          <Spinner size={11} /> Working…
        </span>
      </div>
    </div>
  );
};

/** A phone watching a terminal: the badge, and for a moment what it did. */
export const Live = () => (
  <div style={{ display: "flex", gap: "var(--space-5)", alignItems: "center" }}>
    <span style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
      zsh <LiveBadge icon="device-mobile" tip="Watched from iPhone" />
    </span>
    <span style={{ display: "flex", gap: "var(--space-2)", alignItems: "center" }}>
      claude <LiveBadge icon="device-mobile" note="typed from iPhone" tip="Watched from iPhone" />
    </span>
  </div>
);
