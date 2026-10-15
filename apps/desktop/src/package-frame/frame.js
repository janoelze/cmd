// What every frame widget's page gets before its own markup (cmd-widget://package/,
// main/package-frames.ts): `window.cmd`, the widget API as a page has it (@cmd/widget-api/frame
// types it). The page runs sandboxed in its own opaque origin (no storage, no network but its
// grant's media hosts), so everything goes by postMessage through the app (lib/frames.ts,
// windows/package/frame-api.ts), which hands it to the core; the core checks the widget's grant
// as it does for the widget's process. The verbs and topics come in __CMD_FRAME__ from the
// protocol's registry (API_VERBS, API_TOPICS), so the page's `cmd` has every verb the core
// serves under its own name (cmd.agents.list(), cmd.net.fetch(), cmd.run("gh", …)), nothing
// written here per verb. Its window's state, config and theme come with the first bytes and
// again as they change.
//
// In:  { type: "state", state }, { type: "config", config }, { type: "theme", appearance, vars },
//      { type: "result", id, ok, value | error }, { type: "event", sub, data }, { type: "end", sub, error }
// Out: { type: "ready" }, { type: "state", key, value }, { type: "call", id, verb, params },
//      { type: "subscribe", sub, topic, query }, { type: "unsubscribe", sub },
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
  const api = init.api && typeof init.api === "object" ? init.api : {};
  const verbs = Array.isArray(api.verbs) ? api.verbs.filter((v) => typeof v === "string" && /^\w+\.\w+$/.test(v)) : [];
  const topics = Array.isArray(api.topics) ? api.topics.filter((t) => typeof t === "string" && /^\w+$/.test(t)) : [];
  // A key set here wins over the app's copy for a moment: the app's echo of an older value doesn't undo a slider.
  const mine = new Map();

  const setTheme = (vars) => {
    const root = document.documentElement;
    root.dataset.appearance = appearance;
    root.style.colorScheme = appearance;
    for (const [k, v] of Object.entries(vars || {})) if (/^--[\w-]+$/.test(k) && typeof v === "string") root.style.setProperty(k, v);
  };

  /** A refused or failed call, as @cmd/widget-api's: `code` ("permission", "denied", …) and the `permission` to add. */
  class ApiCallError extends Error {
    constructor(e) {
      super(String((e && e.message) || "refused"));
      this.name = "ApiCallError";
      this.code = (e && e.code) || "failed";
      this.permission = e && e.permission;
    }
  }

  // Calls and subscriptions, answered by the app.
  let nextId = 0;
  const pending = new Map();
  const call = (verb, args) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      const params = [...args];
      while (params.length && params.at(-1) === undefined) params.pop(); // an option left out isn't a null
      post({ type: "call", id, verb, params: copy(params) });
    });
  let nextSub = 0;
  const subs = new Map();
  /** fn(value) now and on each change of a live topic; returns what stops it. A refusal goes to onError (else the console). */
  const subscribe = (topic, query, fn, onError) => {
    if (typeof fn !== "function") throw new TypeError("subscribe: give it a function");
    const sub = ++nextSub;
    subs.set(sub, { fn, onError });
    post({ type: "subscribe", sub, topic: String(topic), query: copy(query) ?? null });
    return () => {
      if (subs.delete(sub)) post({ type: "unsubscribe", sub });
    };
  };

  const cmd = {};
  for (const verb of verbs) {
    const [ns, name] = verb.split(".");
    (cmd[ns] ??= {})[name] = (...args) => call(verb, args);
  }
  // Each live topic: cmd.agents.subscribe(fn) or (query, fn), as cmd.events.subscribe is in a widget's process.
  for (const topic of topics) (cmd[topic] ??= {}).subscribe = (query, fn, onError) => (typeof query === "function" ? subscribe(topic, null, query, fn) : subscribe(topic, query, fn, onError));
  // cmd.run is a function too: cmd.run("gh", ["run", "list"]).
  if (cmd.run?.exec) cmd.run = Object.assign((program, args, opts) => cmd.run.exec(program, args, opts), cmd.run);

  const history = cmd.state?.history;
  cmd.state = {
    /** The window's stored value (the widget's process writes it with cmd.state.set too). */
    get: (key) => copy(kv[key]) ?? null,
    /** Kept by cmd for this window; null removes it. */
    set(key, value) {
      key = String(key);
      if (value === undefined || value === null) delete kv[key];
      else kv[key] = copy(value);
      mine.set(key, Date.now());
      post({ type: "state", key, value: value ?? null });
      return Promise.resolve(null);
    },
    all: () => copy(kv),
    ...(history ? { history } : {}),
  };
  Object.defineProperties(cmd, {
    /** The window's settings (its Configure sheet; never a secret); `cmd.config.get()` as in a widget's process. */
    config: {
      get() {
        const c = copy(config);
        Object.defineProperty(c, "get", { value: () => copy(config) });
        return c;
      },
      enumerable: true,
    },
    /** "dark" or "light". The theme's variables are on :root (var(--text), var(--accent), …). */
    theme: { get: () => appearance, enumerable: true },
  });
  const size = () => (innerWidth < 360 ? "narrow" : innerWidth < 600 ? "regular" : "wide");
  cmd.env = {
    /** cmd's version, the API served and its verbs, the theme and size class. */
    get: () => ({ version: String(api.version || "0.0.0"), api: { major: Number(api.major) || 1, minor: Number(api.minor) || 0 }, verbs: [...verbs], theme: appearance, size: size(), placement: init.placement === "sidebar" ? "sidebar" : "board" }),
    /** Whether this cmd serves a verb ("agents.start"). */
    has: (name) => verbs.includes(name),
  };
  /** fn(value) when the window's "state", "config" or "theme" changes, or on each change of a live topic ("agents", "events" with `query`…); returns what stops it. */
  cmd.on = (type, fn, query) => {
    const list = listeners[type];
    if (list && typeof fn === "function") {
      list.push(fn);
      return () => list.splice(list.indexOf(fn) >>> 0, 1);
    }
    if (topics.includes(type)) return subscribe(type, query, fn);
    return () => {};
  };
  /** Opens a URL, a path or a widget in a window beside this one (cmd.windows.open): works right after a click in the frame. A refusal no one catches is a console line, as it always was. */
  cmd.open = (target) => {
    const p = cmd.windows?.open ? cmd.windows.open(String(target)) : Promise.reject(new ApiCallError({ code: "unknown", message: "This version of cmd can't open windows from a frame." }));
    p.catch((err) => console.warn(`cmd.open: ${err.message}`));
    return p;
  };
  cmd.ApiCallError = ApiCallError;
  window.cmd = cmd;

  window.addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "result") {
      const p = pending.get(m.id);
      if (!p) return;
      pending.delete(m.id);
      if (m.ok) p.resolve(m.value ?? null);
      else p.reject(new ApiCallError(m.error));
    } else if (m.type === "event" || m.type === "end") {
      const s = subs.get(m.sub);
      if (!s) return;
      if (m.type === "event") {
        try {
          s.fn(m.data ?? null);
        } catch (err) {
          report(err);
        }
        return;
      }
      subs.delete(m.sub);
      const err = new ApiCallError(m.error);
      if (s.onError) s.onError(err);
      else console.warn(`cmd: ${err.message}`);
    } else if (m.type === "state" && m.state && typeof m.state === "object") {
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
  // The page never navigates (main stops it): an http(s) link opens in a window through cmd instead.
  const follow = (e) => {
    if (e.defaultPrevented || (e.type === "auxclick" && e.button !== 1)) return;
    const a = e.target instanceof Element && e.target.closest("a[href]");
    if (!a || (a.getAttribute("href") || "").startsWith("#")) return;
    e.preventDefault();
    if (/^https?:\/\//i.test(a.href)) cmd.open(a.href);
  };
  window.addEventListener("click", follow);
  window.addEventListener("auxclick", follow);
  window.open = (url) => (cmd.open(url), null);

  setTheme(null);
  document.addEventListener("DOMContentLoaded", () => post({ type: "ready" }));
})();
