// The runtime inside every Magic widget: the `cmd` object the views use. Data,
// theme and the window's saved state arrive from the host by postMessage
// ({type:"render"} / {type:"data"} / {type:"tokens"}); a standalone page (a
// preview) sets window.__CMD_DATA__. cmd.state is kept by the core in the
// window's state (the frame is sandboxed without an origin of its own, so it
// has no localStorage): set() posts the change to the host.
(() => {
  const listeners = [];
  let latest;
  let has = false;
  let kv = {};
  const store = {
    get(k) {
      const v = kv[k];
      return v === undefined ? undefined : JSON.parse(JSON.stringify(v));
    },
    set(k, v) {
      if (v === undefined || v === null) delete kv[k];
      else kv[k] = JSON.parse(JSON.stringify(v));
      try {
        if (parent !== window) parent.postMessage({ type: "state-set", key: String(k), value: v ?? null }, "*");
      } catch {}
    },
  };

  const receive = (d) => {
    latest = d;
    has = true;
    for (const fn of listeners) call(fn, d);
    fit();
  };

  // Panes (kit.css .k-panes), fitted to the window's height like a terminal UI:
  // while the page overflows, the longest pane loses its last row (down to
  // MIN_ROWS), then the last pane goes, then the first pane's rows.
  const MIN_ROWS = 3;
  const fit = () => {
    for (const el of document.querySelectorAll(".k-cut")) el.classList.remove("k-cut");
    const panes = [...document.querySelectorAll(".k-pane")];
    if (!panes.length) return;
    const root = document.scrollingElement || document.documentElement;
    const rows = (p) => [...p.querySelectorAll("tbody > tr, .k-list > li")].filter((r) => !r.classList.contains("k-cut"));
    for (let guard = 0; guard < 1000 && root.scrollHeight > innerHeight + 1; guard++) {
      const shown = panes.filter((p) => !p.classList.contains("k-cut")).map((p) => ({ p, rows: rows(p) }));
      const longest = shown.reduce((a, b) => (b.rows.length > a.rows.length ? b : a));
      if (longest.rows.length > MIN_ROWS) longest.rows.at(-1).classList.add("k-cut");
      else if (shown.length > 1) shown.at(-1).p.classList.add("k-cut");
      else if (longest.rows.length > 1) longest.rows.at(-1).classList.add("k-cut");
      else break;
    }
  };
  let fitting = 0;
  window.addEventListener("resize", () => {
    cancelAnimationFrame(fitting);
    fitting = requestAnimationFrame(fit);
  });
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
      if (locked()) return;
      try {
        parent.postMessage({ type: "open-url", url: String(url) }, "*");
      } catch {}
    },
    /** A new terminal in the window's folder with `command` typed in; the person presses Return. */
    terminal(command) {
      act({ type: "terminal", command: String(command) });
    },
    /** Open a file or folder (an absolute or ~/ path) in a cmd window. */
    open(path) {
      act({ type: "open", path: String(path) });
    },
    copy(text) {
      act({ type: "copy", text: String(text) });
    },
    /** Play a macOS system sound ("Glass", "Ping", "Basso", …). */
    sound(name = "Glass") {
      try {
        parent.postMessage({ type: "sound", name: String(name) }, "*");
      } catch {}
    },
  };

  // Things done on the person's behalf only follow a click or key press in the
  // widget, so code that runs on every refresh can't open terminals.
  const act = (m) => {
    if (m.type !== "copy" && locked()) return;
    if (navigator.userActivation && !navigator.userActivation.isActive) {
      report(new Error(`cmd.${m.type}() only works in response to a click or key press`));
      return;
    }
    try {
      parent.postMessage(m, "*");
    } catch {}
  };

  // Links and actions that open things work only while the window is selected
  // (the host says, {type:"active"}), so scrolling past windows in a strip
  // can't open browser windows by accident. A click that began on a window
  // that wasn't selected only selects it, though that press selects it before
  // the click arrives. Standalone pages (previews) are always active.
  let active = parent === window;
  let pressedInactive = false;
  const setActive = (v) => {
    active = !!v;
    document.documentElement.classList.toggle("k-active", active);
  };
  setActive(active);
  const locked = () => !active || pressedInactive;

  // The app can't see the pointer over this page (it runs in its own process),
  // so report presses (the window gets selected, like any other) and
  // right-clicks (the window's menu opens: Change, Refresh, …).
  window.addEventListener(
    "pointerdown",
    (e) => {
      pressedInactive = !active;
      if (e.button !== 0) return;
      try {
        parent.postMessage({ type: "press" }, "*");
      } catch {}
    },
    { capture: true, passive: true },
  );
  // Links: the frame may not navigate (main stops it, leaving it blank), so a
  // click on any http(s) link, target or not, opens it through the host instead.
  // In-page anchors still scroll; other schemes do nothing.
  const follow = (e) => {
    if (e.defaultPrevented || (e.type === "auxclick" && e.button !== 1)) return;
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a) return;
    const href = a.getAttribute("href") || "";
    if (href.startsWith("#")) return;
    e.preventDefault();
    if (/^https?:$/i.test(a.protocol)) window.cmd.openUrl(a.href); // a no-op while locked
  };
  window.addEventListener("click", follow);
  window.addEventListener("auxclick", follow);
  window.open = (url) => {
    try {
      const u = new URL(String(url), "https://invalid/");
      if (/^https?:$/.test(u.protocol) && u.host !== "invalid") window.cmd.openUrl(u.href);
    } catch {}
    return null;
  };
  window.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      try {
        parent.postMessage({ type: "contextmenu" }, "*");
      } catch {}
    },
    { capture: true },
  );

  // Sliders (.k-range) show their value as a filled track (--v), as the person drags and when code sets it.
  const syncRange = (el) => {
    const min = Number(el.min || 0), max = Number(el.max || 100), v = Number(el.value);
    el.style.setProperty("--v", `${((v - min) / (max - min || 1)) * 100}%`);
  };
  const syncRanges = () => document.querySelectorAll("input.k-range").forEach(syncRange);
  document.addEventListener("input", (e) => e.target instanceof HTMLInputElement && e.target.classList.contains("k-range") && syncRange(e.target), true);
  const valueSetter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value");
  Object.defineProperty(HTMLInputElement.prototype, "value", {
    get() {
      return valueSetter.get.call(this);
    },
    set(v) {
      valueSetter.set.call(this, v);
      if (this.classList?.contains("k-range")) syncRange(this);
    },
  });

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
    if (m.type === "active") setActive(m.active);
    if (m.type === "stream") (setTokens(m.tokens), stream(m.html));
    if (m.type === "render") {
      setTokens(m.tokens);
      if ("active" in m) setActive(m.active);
      if (m.kv && typeof m.kv === "object") kv = m.kv;
      render(m.html);
      if ("data" in m && m.data !== undefined) receive(m.data);
      else fit();
      syncRanges();
      // Painted with its data: the host shows the frame only now (two frames: after layout and paint).
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          try {
            parent.postMessage({ type: "rendered" }, "*");
          } catch {}
        }),
      );
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
    else fit();
    syncRanges();
  });
})();
