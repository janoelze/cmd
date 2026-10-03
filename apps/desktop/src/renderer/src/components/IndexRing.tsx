// Transcript indexing progress as a small ring, shown inside search fields while
// the index is being (re)built. Nothing is shown when the index is current.

import type { SearchStatus } from "@cmd/protocol";

const R = 5;
const C = 2 * Math.PI * R;

export function IndexRing({ status, className }: { status: SearchStatus | null; className?: string }) {
  if (!status?.indexing || !status.total) return null;
  const frac = Math.min(1, status.done / status.total);
  const title = `Indexing past sessions: ${status.done.toLocaleString()} / ${status.total.toLocaleString()}`;
  return (
    <svg className={`index-ring ${className ?? ""}`} width={14} height={14} viewBox="0 0 14 14" role="progressbar" aria-label={title} aria-valuenow={Math.round(frac * 100)}>
      <title>{title}</title>
      <circle className="index-ring-track" cx={7} cy={7} r={R} />
      <circle className="index-ring-fill" cx={7} cy={7} r={R} strokeDasharray={`${frac * C} ${C}`} transform="rotate(-90 7 7)" />
    </svg>
  );
}
