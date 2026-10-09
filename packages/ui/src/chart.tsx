// Draft (docs/40-window-design.md): charts. Series take the --chart-N colours
// in order (the theme's terminal colours), never their own. Thin lines with a
// soft area, thin bars, a few grid lines and labels; a legend only for more
// than one series. Charts are as wide as their container and redraw on resize,
// so lines stay one pixel wherever they are.

import { useLayoutEffect, useRef, useState, type ReactNode } from "react";

export interface Series {
  name: string;
  values: readonly number[];
}

function useWidth<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [w, setW] = useState(0);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const ro = new ResizeObserver(() => setW(el.clientWidth));
    ro.observe(el);
    setW(el.clientWidth);
    return () => ro.disconnect();
  }, []);
  return [ref, w] as const;
}

const color = (i: number) => `var(--chart-${(i % 6) + 1})`;
const nice = (max: number) => {
  if (max <= 0) return 1;
  const p = 10 ** Math.floor(Math.log10(max));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((v) => v >= max) ?? max;
};

/** The series' names and colours, for a chart with more than one. */
export function Legend({ series }: { series: readonly Series[] }) {
  return (
    <div className="ui-legend">
      {series.map((s, i) => (
        <span key={s.name} className="ui-legend-item">
          <i style={{ background: color(i) }} />
          {s.name}
        </span>
      ))}
    </div>
  );
}

/**
 * A line, area or bar chart. `labels` name the x positions (the first and last
 * are shown); `format` writes the y axis' values; `height` in px.
 */
export function Chart({ kind = "area", series, labels, height = 140, format = String, max: fixedMax }: { kind?: "line" | "area" | "bar"; series: readonly Series[]; labels?: readonly ReactNode[]; height?: number; format?: (v: number) => string; max?: number }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const n = Math.max(...series.map((s) => s.values.length));
  const max = fixedMax ?? nice(Math.max(...series.flatMap((s) => s.values)));
  // The y axis is on the trailing edge, as in Swift Charts: the plot starts at the left edge,
  // in line with what's above it (a Pane's title), and the labels right-align with the
  // Pane's aside (its unit). Their column is as wide as the longest label.
  const grid = [0, 0.5, 1].map((f) => f * max);
  const axis = Math.max(...grid.map((g) => format(g).length)) * 6.2 + 8;
  const pad = { l: 0, r: axis, t: 6, b: labels ? 18 : 4 };
  const iw = Math.max(0, w - pad.l - pad.r);
  const ih = height - pad.t - pad.b;
  const x = (i: number) => pad.l + (n <= 1 ? 0 : (i / (n - 1)) * iw);
  const y = (v: number) => pad.t + ih - (v / max) * ih;
  const band = iw / n;
  const bw = Math.max(2, Math.min(18, (band * 0.7) / series.length));
  return (
    <div className="ui-chart">
      {series.length > 1 && <Legend series={series} />}
      <div ref={ref} className="ui-chart-plot" style={{ height }}>
        {w > 0 && (
          <svg width={w} height={height} role="img" aria-label={series.map((s) => s.name).join(", ")}>
            {grid.map((g) => (
              <g key={g}>
                <line className="ui-chart-grid" x1={pad.l} x2={w - pad.r} y1={Math.round(y(g)) + 0.5} y2={Math.round(y(g)) + 0.5} />
                <text className="ui-chart-tick" x={w} y={y(g)} textAnchor="end" dominantBaseline="middle">
                  {format(g)}
                </text>
              </g>
            ))}
            {kind === "bar"
              ? series.map((s, k) =>
                  s.values.map((v, i) => {
                    const bx = pad.l + i * band + (band - bw * series.length) / 2 + k * bw;
                    return <rect key={`${k}-${i}`} x={bx} y={y(v)} width={bw - 1} height={Math.max(0, pad.t + ih - y(v))} rx={1.5} fill={color(k)} />;
                  }),
                )
              : series.map((s, k) => {
                  const pts = s.values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`);
                  return (
                    <g key={s.name}>
                      {kind === "area" && <path d={`M${x(0)},${pad.t + ih}L${pts.join("L")}L${x(s.values.length - 1)},${pad.t + ih}Z`} fill={color(k)} className="ui-chart-area" />}
                      <path d={`M${pts.join("L")}`} stroke={color(k)} className="ui-chart-line" />
                    </g>
                  );
                })}
            {labels && labels.length > 0 && (
              <>
                <text className="ui-chart-tick" x={pad.l} y={height - 4}>
                  {labels[0]}
                </text>
                <text className="ui-chart-tick" x={w - pad.r} y={height - 4} textAnchor="end">
                  {labels[labels.length - 1]}
                </text>
              </>
            )}
          </svg>
        )}
      </div>
    </div>
  );
}

/** A small trend without axes, for a Stat or a table cell. */
export function Sparkline({ values, series = 0, height = 20, area = true }: { values: readonly number[]; series?: number; height?: number; area?: boolean }) {
  const [ref, w] = useWidth<HTMLDivElement>();
  const max = Math.max(...values) || 1;
  const min = Math.min(...values);
  const x = (i: number) => (values.length <= 1 ? 0 : (i / (values.length - 1)) * w);
  const y = (v: number) => 1 + (height - 2) * (1 - (v - min) / (max - min || 1));
  const pts = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join("L");
  return (
    <div ref={ref} className="ui-sparkline" style={{ height }}>
      {w > 0 && (
        <svg width={w} height={height} aria-hidden>
          {area && <path d={`M0,${height}L${pts}L${w},${height}Z`} fill={color(series)} className="ui-chart-area" />}
          <path d={`M${pts}`} stroke={color(series)} className="ui-chart-line" />
        </svg>
      )}
    </div>
  );
}
