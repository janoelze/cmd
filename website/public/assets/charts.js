// The usage page's per-day charts: days() (_lib/layout.php) renders plain
// columns, and this draws each `.chart[data-days]` over them with uPlot
// (assets/vendor/uplot, MIT): bars in the accent, a hairline grid, a tooltip
// per day. Colours and type come from the page's tokens. Without JS or uPlot
// the columns stay.

(() => {
  if (typeof uPlot !== "function") return;
  const css = getComputedStyle(document.documentElement);
  const token = (name) => css.getPropertyValue(name).trim();
  const font = `12px ${token("--sans")}`;
  const HEIGHT = 160;
  const day = new Intl.DateTimeFormat("en", { month: "short", day: "numeric", timeZone: "UTC" });

  for (const el of document.querySelectorAll(".chart[data-days]")) {
    const days = JSON.parse(el.dataset.days);
    const unit = el.dataset.unit;
    const xs = Object.keys(days).map((d) => Date.parse(`${d}T00:00:00Z`) / 1000);
    const ys = Object.values(days);
    const axis = { stroke: token("--ink-3"), font, ticks: { show: false }, grid: { show: false } };
    const tip = document.createElement("div");
    tip.className = "chart-tip";
    tip.hidden = true;

    const u = new uPlot(
      {
        width: el.clientWidth,
        height: HEIGHT,
        padding: [12, 16, 0, 0], // room on the right for the last day's label
        legend: { show: false },
        tzDate: (t) => uPlot.tzDate(new Date(t * 1000), "Etc/UTC"), // ticks on UTC days, as the data
        cursor: {
          y: false,
          points: { show: false },
          drag: { x: false, y: false },
          move: (self, left, top) => (left < 0 ? [left, top] : [self.valToPos(xs[self.posToIdx(left)], "x"), top]), // on the bar's middle; < 0: away
        },
        scales: {
          x: { time: true, range: (_, min, max) => [min - 43200, max + 43200] },
          y: { range: (_, __, max) => [0, Math.max(max, 4) * 1.08] },
        },
        axes: [
          { ...axis, size: 28, gap: 8, space: 64, values: (_, ts) => ts.map((t) => day.format(t * 1000)) },
          { ...axis, size: 36, space: 32, grid: { stroke: token("--line"), width: 1 },
            values: (_, ts) => ts.map((n) => (n === 0 ? "" : n.toLocaleString("en"))), // the baseline needs no 0, which sat on the dates
            incrs: [1, 2, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000] },
        ],
        series: [
          {},
          {
            fill: token("--accent"),
            width: 0,
            points: { show: false },
            // Rounded tops on a square baseline, 2px apart.
            paths: uPlot.paths.bars({ size: [0.8, 24], gap: 2, radius: [0.25, 0] }),
          },
        ],
        hooks: {
          setCursor: [
            (self) => {
              const i = self.cursor.idx;
              if (i == null) return void (tip.hidden = true);
              tip.hidden = false;
              tip.innerHTML = "";
              const n = document.createElement("b");
              n.textContent = ys[i].toLocaleString("en");
              tip.append(`${day.format(xs[i] * 1000)} · `, n, ` ${ys[i] === 1 ? unit.replace(/s$/, "") : unit}`);
              const x = self.valToPos(xs[i], "x") + self.over.offsetLeft;
              const half = tip.offsetWidth / 2;
              tip.style.left = `${Math.min(Math.max(x, half), el.clientWidth - half)}px`;
            },
          ],
        },
      },
      [xs, ys],
      (self, init) => {
        el.replaceChildren(self.root, tip);
        init();
      },
    );
    new ResizeObserver(() => u.setSize({ width: el.clientWidth, height: HEIGHT })).observe(el);
  }
})();
