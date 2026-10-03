// The runtime inside every Magic widget: the `cmd` object the model's views
// use. Data and theme arrive from the host by postMessage ({type:"data"} /
// {type:"tokens"}); a standalone page (cmd magic --out) sets window.__CMD_DATA__.
(() => {
  const listeners = [];
  let latest;
  let has = false;
  const mem = {};
  const store = {
    get(k) {
      try {
        const v = localStorage.getItem("cmd:" + k);
        return v === null ? mem[k] : JSON.parse(v);
      } catch {
        return mem[k];
      }
    },
    set(k, v) {
      mem[k] = v;
      try {
        localStorage.setItem("cmd:" + k, JSON.stringify(v));
      } catch {}
    },
  };

  const receive = (d) => {
    latest = d;
    has = true;
    for (const fn of listeners) call(fn, d);
  };
  const call = (fn, d) => {
    try {
      fn(d);
    } catch (e) {
      report(e);
    }
  };
  const report = (e) => {
    const msg = { type: "error", message: String((e && e.message) || e), stack: e && e.stack ? String(e.stack).slice(0, 2000) : "" };
    (window.__CMD_ERRORS__ ||= []).push(msg);
    try {
      parent.postMessage(msg, "*");
    } catch {}
  };
  window.addEventListener("error", (e) => report(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason));

  const toMs = (t) => {
    if (t instanceof Date) return t.getTime();
    if (typeof t === "string") return Date.parse(t);
    if (typeof t === "number") return t < 1e12 ? t * 1000 : t;
    return NaN;
  };
  const nf = (d) => new Intl.NumberFormat(undefined, { maximumFractionDigits: d });
  const fmt = {
    num: (n, digits) => (n == null || isNaN(n) ? "–" : nf(digits ?? (Math.abs(n) >= 100 ? 0 : Math.abs(n) >= 10 ? 1 : 2)).format(n)),
    bytes: (n) => {
      if (n == null || isNaN(n)) return "–";
      const u = ["B", "KB", "MB", "GB", "TB", "PB"];
      let i = 0;
      while (Math.abs(n) >= 1024 && i < u.length - 1) (n /= 1024), i++;
      return fmt.num(n, i === 0 ? 0 : n >= 100 ? 0 : 1) + " " + u[i];
    },
    pct: (n, digits) => (n == null || isNaN(n) ? "–" : fmt.num(n, digits ?? (n < 10 ? 1 : 0)) + "%"),
    dur: (s) => {
      if (s == null || isNaN(s)) return "–";
      s = Math.round(s);
      const d = Math.floor(s / 86400), h = Math.floor((s % 86400) / 3600), m = Math.floor((s % 3600) / 60);
      return d ? `${d}d ${h}h` : h ? `${h}h ${m}m` : m ? `${m}m ${s % 60}s` : `${s}s`;
    },
    ago: (t) => {
      const s = Math.max(0, Math.round((Date.now() - toMs(t)) / 1000));
      if (isNaN(s)) return "–";
      return s < 45 ? "just now" : s < 3600 ? `${Math.round(s / 60)}m ago` : s < 86400 ? `${Math.round(s / 3600)}h ago` : `${Math.round(s / 86400)}d ago`;
    },
    time: (t) => new Date(toMs(t)).toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" }),
    date: (t) => new Date(toMs(t)).toLocaleDateString(undefined, { weekday: "short", day: "numeric", month: "short" }),
  };

  const NS = "http://www.w3.org/2000/svg";
  const svgEl = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    return e;
  };
  const color = (i) => `var(--c${(i % 6) + 1})`;

  function spark(el, values, o = {}) {
    const v = (values || []).filter((x) => typeof x === "number" && !isNaN(x));
    const w = el.clientWidth || 120, h = el.clientHeight || 28;
    el.replaceChildren();
    if (v.length < 2) return;
    const min = o.min ?? Math.min(...v), max = o.max ?? Math.max(...v), span = max - min || 1;
    const pts = v.map((x, i) => [(i / (v.length - 1)) * (w - 4) + 2, h - 3 - ((x - min) / span) * (h - 6)]);
    const svg = svgEl("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    svg.append(
      svgEl("polyline", { points: pts.map((p) => p.join(",")).join(" "), fill: "none", stroke: o.color || "var(--c1)", "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }),
      svgEl("circle", { cx: pts.at(-1)[0], cy: pts.at(-1)[1], r: 2.5, fill: o.color || "var(--c1)" }),
    );
    el.append(svg);
  }

  function drawChart(el) {
    const o = el.__chart;
    const series = (o.series || []).map((s) => ({ name: s.name, values: (s.values || []).map(Number) }));
    const n = Math.max(0, ...series.map((s) => s.values.length));
    const w = el.clientWidth || 300, h = el.clientHeight || 120;
    el.replaceChildren();
    if (!n) return;
    const all = series.flatMap((s) => s.values).filter((x) => !isNaN(x));
    let min = o.min ?? Math.min(...all), max = o.max ?? Math.max(...all);
    // Bars grow from zero; lines use the data's range (with a little air) so changes show.
    if (o.type === "bar") min = Math.min(0, min);
    else if (o.min === undefined && o.max === undefined) {
      const pad = (max - min) * 0.08 || Math.abs(max) * 0.01 || 1;
      min -= pad;
      max += pad;
    }
    if (max === min) max = min + 1;
    const fmtY = o.format || ((x) => fmt.num(x));
    const left = 4, right = 4 + Math.max(fmtY(max).length, fmtY(min).length) * 6.5, top = 6, bottom = o.labels ? 18 : 6;
    const pw = w - left - right, ph = h - top - bottom;
    const y = (v) => top + ph - ((v - min) / (max - min)) * ph;
    const svg = svgEl("svg", { width: w, height: h, viewBox: `0 0 ${w} ${h}` });
    if (n === 1 && o.type !== "bar") {
      // One point so far (e.g. cmd.history on a fresh window): show it as a dot, not nothing.
      series.forEach((s, si) => svg.append(svgEl("circle", { cx: left + pw, cy: y(s.values[0]), r: 2.5, fill: s.color || color(si) })));
    }
    for (const v of [max, min]) {
      svg.append(svgEl("line", { x1: left, x2: left + pw, y1: y(v), y2: y(v), stroke: "var(--line)" }));
      const t = svgEl("text", { x: w - 2, y: y(v) + 4, "text-anchor": "end", fill: "var(--text-dim)", "font-size": 10 });
      t.textContent = fmtY(v);
      svg.append(t);
    }
    if (o.type === "bar") {
      const gw = pw / n, bw = Math.max(1, (gw * 0.7) / series.length);
      series.forEach((s, si) =>
        s.values.forEach((v, i) => {
          const x = left + i * gw + gw * 0.15 + si * bw;
          svg.append(svgEl("rect", { x, y: Math.min(y(v), y(0)), width: bw - 1, height: Math.abs(y(v) - y(0)), rx: 1.5, fill: s.color || color(si) }));
        }),
      );
    } else {
      const x = (i) => left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
      series.forEach((s, si) => {
        const c = s.color || color(si);
        const xy = s.values.map((v, i) => (isNaN(v) ? null : [x(i), y(v)])).filter(Boolean);
        if (o.area && xy.length > 1) {
          const d = `M${xy[0][0]},${y(min)} ` + xy.map((p) => `L${p[0]},${p[1]}`).join(" ") + ` L${xy.at(-1)[0]},${y(min)} Z`;
          svg.append(svgEl("path", { d, style: `fill: color-mix(in srgb, ${c} 16%, transparent)` }));
        }
        svg.append(svgEl("polyline", { points: xy.map((p) => p.join(",")).join(" "), fill: "none", stroke: c, "stroke-width": 1.5, "stroke-linejoin": "round", "stroke-linecap": "round" }));
      });
    }
    if (o.labels && o.labels.length) {
      const idx = o.labels.length <= 6 ? o.labels.map((_, i) => i) : [0, Math.floor((o.labels.length - 1) / 2), o.labels.length - 1];
      for (const i of idx) {
        const gx = o.type === "bar" ? left + (i + 0.5) * (pw / n) : left + (n === 1 ? pw / 2 : (i / (n - 1)) * pw);
        const anchor = o.type === "bar" ? "middle" : i === 0 ? "start" : i === o.labels.length - 1 ? "end" : "middle";
        const t = svgEl("text", { x: gx, y: h - 4, "text-anchor": anchor, fill: "var(--text-dim)", "font-size": 10 });
        t.textContent = String(o.labels[i]);
        svg.append(t);
      }
    }
    el.append(svg);
  }

  function chart(el, o) {
    el.__chart = o;
    drawChart(el);
    if (!el.__ro) {
      el.__ro = new ResizeObserver(() => el.__chart && drawChart(el));
      el.__ro.observe(el);
    }
  }

  window.cmd = {
    onData(fn) {
      listeners.push(fn);
      if (has) call(fn, latest);
    },
    get data() {
      return latest;
    },
    /** fn(appearance) now (once a theme is set) and whenever the theme changes. */
    onTheme(fn) {
      themeListeners.push(fn);
      const root = getComputedStyle(document.documentElement);
      if (root.getPropertyValue("--bg")) call(fn, root.colorScheme || "dark");
    },
    fmt,
    spark,
    chart,
    state: store,
    /** Keep the last `max` values of a live number across refreshes (for sparklines). */
    history(key, value, max = 60) {
      const h = store.get("h:" + key) || [];
      if (typeof value === "number" && !isNaN(value)) h.push(value);
      while (h.length > max) h.shift();
      store.set("h:" + key, h);
      return h;
    },
    openUrl(url) {
      try {
        parent.postMessage({ type: "open-url", url: String(url) }, "*");
      } catch {}
    },
  };

  // Sideways scrolling belongs to cmd (the strip scrolls) unless the widget
  // itself scrolls sideways right there. An iframe's wheel events never reach
  // the app, so hand those over (apps/desktop/src/renderer/src/embed.ts).
  const scrollsX = (el, dx) => {
    for (let n = el; n && n !== document.documentElement; n = n.parentElement) {
      const ox = getComputedStyle(n).overflowX;
      if ((ox === "auto" || ox === "scroll") && n.scrollWidth > n.clientWidth) {
        if (dx < 0 ? n.scrollLeft > 0 : n.scrollLeft + n.clientWidth < n.scrollWidth - 1) return true;
      }
    }
    return false;
  };
  window.addEventListener(
    "wheel",
    (e) => {
      if (e.ctrlKey || e.metaKey) return;
      const dx = e.shiftKey && !e.deltaX ? e.deltaY : e.deltaX;
      const sideways = e.shiftKey || Math.abs(e.deltaX) > Math.abs(e.deltaY);
      if (!sideways || !dx || scrollsX(e.target, dx)) return;
      e.preventDefault();
      try {
        parent.postMessage({ type: "wheel", deltaX: e.deltaX, deltaY: e.deltaY, deltaMode: e.deltaMode, shiftKey: e.shiftKey, ctrlKey: e.ctrlKey, metaKey: e.metaKey, altKey: e.altKey, x: e.clientX, y: e.clientY }, "*");
      } catch {}
    },
    { passive: false },
  );

  // The app can't see the pointer over this page (it runs in its own process),
  // so report presses (the window gets selected, like any other) and when the
  // pointer enters and leaves (the window shows its controls on hover).
  window.addEventListener(
    "pointerdown",
    (e) => {
      if (e.button !== 0) return;
      try {
        parent.postMessage({ type: "press" }, "*");
      } catch {}
    },
    { capture: true, passive: true },
  );
  let inside = false;
  const hover = (on) => {
    if (on === inside) return;
    inside = on;
    try {
      parent.postMessage({ type: "hover", on }, "*");
    } catch {}
  };
  document.addEventListener("mousemove", () => hover(true), { passive: true });
  document.documentElement.addEventListener("mouseleave", () => hover(false));

  // Theme: CSS variables update by themselves; code that draws with colours
  // (a canvas) re-reads them in cmd.onTheme, called now and on every change.
  const themeListeners = [];
  let lastTokens = "";
  const setTokens = (tokens) => {
    if (!tokens) return;
    const key = JSON.stringify(tokens);
    if (key === lastTokens) return;
    lastTokens = key;
    for (const k in tokens) {
      if (k === "color-scheme") document.documentElement.style.colorScheme = tokens[k];
      else document.documentElement.style.setProperty(k, tokens[k]);
    }
    for (const fn of themeListeners) call(fn, tokens["color-scheme"]);
  };
  // While the answer streams: the markup so far, without scripts (they run once, at the end).
  const stream = (html) => {
    document.body.innerHTML = String(html)
      .replace(/<script[\s\S]*?(<\/script>|$)/gi, "")
      .replace(/<style[\s\S]*?(<\/style>|$)/gi, (m) => (m.endsWith("</style>") ? m : ""));
  };
  // The finished widget: markup, then its scripts in order (innerHTML doesn't run them).
  const render = (html) => {
    listeners.length = 0;
    themeListeners.length = 0;
    has = false;
    document.body.innerHTML = String(html);
    for (const old of [...document.body.querySelectorAll("script")]) {
      const s = document.createElement("script");
      s.textContent = old.textContent;
      old.replaceWith(s);
    }
  };

  // Messages from the host (cmd's renderer). An opaque-origin frame can only be
  // talked to by whoever embeds it, so the origin isn't checked.
  window.addEventListener("message", (e) => {
    const m = e.data;
    if (!m || typeof m !== "object") return;
    if (m.type === "tokens") setTokens(m.tokens);
    if (m.type === "stream") (setTokens(m.tokens), stream(m.html));
    if (m.type === "render") {
      setTokens(m.tokens);
      render(m.html);
      if ("data" in m && m.data !== undefined) receive(m.data);
    }
    if (m.type === "data") receive(m.data);
  });
  document.addEventListener("DOMContentLoaded", () => {
    try {
      if (parent !== window) parent.postMessage({ type: "ready" }, "*");
    } catch {}
  });
  // Standalone pages inline their data in a script that runs after this one.
  document.addEventListener("DOMContentLoaded", () => {
    if ("__CMD_DATA__" in window) receive(window.__CMD_DATA__);
  });
})();
