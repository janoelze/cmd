// What every frame widget's page gets before its own markup (cmd-widget://package/,
// main/package-frames.ts): `window.cmd`, the little a view.html has of cmd. The page runs
// sandboxed in its own opaque origin (no storage, no network but its grant's media hosts),
// so its window's state, config and theme come from the app (lib/frames.ts) by postMessage,
// and what it asks goes back the same way; the app decides (state through the widget API,
// a link only right after a press in the frame). The first values are in __CMD_FRAME__.
//
// In:  { type: "state", state }, { type: "config", config }, { type: "theme", appearance, vars }
// Out: { type: "ready" }, { type: "state", key, value }, { type: "open", url },
//      { type: "press" }, { type: "contextmenu" }, { type: "error", message }

(() => {
  const init = window.__CMD_FRAME__ || {};
  delete window.__CMD_FRAME__;
  const post = (m) => {
    try {
      parent.postMessage(m, "*");
    } catch {}
  };
  const copy = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const listeners = { state: [], config: [], theme: [] };
  const emit = (type, value) => {
    for (const fn of listeners[type]) {
      try {
        fn(value);
      } catch (e) {
        report(e);
      }
    }
  };
  const report = (e) => post({ type: "error", message: String((e && e.message) || e).slice(0, 500) });
  window.addEventListener("error", (e) => report(e.error || e.message));
  window.addEventListener("unhandledrejection", (e) => report(e.reason));

  let kv = init.state && typeof init.state === "object" ? init.state : {};
  let config = init.config && typeof init.config === "object" ? init.config : {};
  let appearance = init.appearance === "light" ? "light" : "dark";
  // A key set here wins over the app's copy for a moment: the app's echo of an older value doesn't undo a slider.
  const mine = new Map();

  const setTheme = (vars) => {
    const root = document.documentElement;
    root.dataset.appearance = appearance;
    root.style.colorScheme = appearance;
    for (const [k, v] of Object.entries(vars || {})) if (/^--[\w-]+$/.test(k) && typeof v === "string") root.style.setProperty(k, v);
  };

  window.cmd = {
    state: {
      /** The window's stored value (the widget's process writes it with cmd.state.set too). */
      get: (key) => copy(kv[key]),
      /** Kept by cmd for this window; null removes it. */
      set(key, value) {
        key = String(key);
        if (value === undefined || value === null) delete kv[key];
        else kv[key] = copy(value);
        mine.set(key, Date.now());
        post({ type: "state", key, value: value ?? null });
      },
      all: () => copy(kv),
    },
    /** The window's settings (its Configure sheet; never a secret). */
    get config() {
      return copy(config);
    },
    /** "dark" or "light". The theme's variables are on :root (var(--text), var(--accent), …). */
    get theme() {
      return appearance;
    },
    /** fn(value) when the window's "state", "config" or "theme" changes; returns what stops it. */
    on(type, fn) {
      const list = listeners[type];
      if (!list || typeof fn !== "function") return () => {};
      list.push(fn);
      return () => list.splice(list.indexOf(fn) >>> 0, 1);
    },
    /** Open an http(s) URL in a browser window: works right after a click in the frame. */
    open(url) {
      try {
        const u = new URL(String(url), "https://invalid/");
        if (/^https?:$/.test(u.protocol) && u.host !== "invalid") post({ type: "open", url: u.href });
      } catch {}
    },
  };

  window.addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "state" && m.state && typeof m.state === "object") {
      const now = Date.now();
      const next = { ...m.state };
      for (const [k, at] of mine) {
        if (now - at > 1500) mine.delete(k);
        else if (k in kv) next[k] = kv[k];
        else delete next[k];
      }
      if (JSON.stringify(next) === JSON.stringify(kv)) return;
      kv = next;
      emit("state", copy(kv));
    } else if (m.type === "config" && m.config && typeof m.config === "object") {
      config = m.config;
      emit("config", copy(config));
    } else if (m.type === "theme") {
      appearance = m.appearance === "light" ? "light" : "dark";
      setTheme(m.vars);
      emit("theme", appearance);
    }
  });

  // The app can't see the pointer in here: presses select the window, right-clicks open its menu.
  window.addEventListener("pointerdown", (e) => e.button === 0 && post({ type: "press" }), { capture: true, passive: true });
  window.addEventListener(
    "contextmenu",
    (e) => {
      e.preventDefault();
      post({ type: "contextmenu" });
    },
    { capture: true },
  );
  // The page never navigates (main stops it): an http(s) link opens through the app instead.
  const follow = (e) => {
    if (e.defaultPrevented || (e.type === "auxclick" && e.button !== 1)) return;
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a || (a.getAttribute("href") || "").startsWith("#")) return;
    e.preventDefault();
    window.cmd.open(a.href);
  };
  window.addEventListener("click", follow);
  window.addEventListener("auxclick", follow);
  window.open = (url) => (window.cmd.open(url), null);

  setTheme(null);
  document.addEventListener("DOMContentLoaded", () => post({ type: "ready" }));
})();
