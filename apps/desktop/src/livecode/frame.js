// The page a Live Code window plays in (cmd-livecode://frame/, main/frames.ts):
// Strudel (@strudel/web) evaluating the window's code and playing it, and a
// scope of what it plays, drawn across the frame (the strip under the editor).
// The code is the person's or the AI's, so this runs sandboxed in its own opaque
// origin; it may fetch samples from GitHub and nothing else.
//
// An edit only replaces what plays if it evaluates and its first cycles can be
// queried: a broken edit reports its error and the last good pattern plays on.
//
// In:  { type: "eval", id, code }, { type: "stop" }, { type: "pause" }, { type: "resume" }, { type: "listen", on }, { type: "colors", line, bg }
// Out: { type: "ready", sounds }, { type: "evaluated", id, ok, error? }, { type: "state", started, error },
//      { type: "levels", t, l, r }, { type: "press" }, { type: "contextmenu" }

(() => {
  const S = window.strudel;
  const post = (m) => parent.postMessage(m, "*");
  const msg = (err) => String(err?.message ?? err);

  // Strudel's own sample maps, as strudel.cc loads them.
  const MAPS = "https://raw.githubusercontent.com/felixroos/dough-samples/main/";
  const BANKS = ["tidal-drum-machines", "piano", "Dirt-Samples", "EmuSP12", "vcsl", "mridangam"];

  let pending = null; // the id of the eval in flight
  const settle = (ok, error) => {
    if (pending === null) return;
    post({ type: "evaluated", id: pending, ok, ...(error ? { error } : {}) });
    pending = null;
  };

  const ready = initStrudel({
    prebake: () => Promise.all(BANKS.map((b) => S.samples(`${MAPS}${b}.json`).catch((err) => console.warn(`samples ${b}:`, msg(err))))),
    // A pattern that throws when queried would play silence and log on every tick: refuse it here.
    editPattern: (pattern) => (pattern.queryArc(0, 2), pattern),
    afterEval: () => settle(true),
    onEvalError: (err) => settle(false, msg(err)),
    onUpdateState: (s) => post({ type: "state", started: !!s.started, error: s.schedulerError ? msg(s.schedulerError) : null }),
  });

  const run = async (id, code) => {
    await ready;
    pending = id;
    try {
      await S.evaluate(code);
    } catch (err) {
      settle(false, msg(err));
    }
    settle(true);
  };

  // ── what it sounds like: levels for Visualizers, and the scope ──
  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const g = canvas.getContext("2d");
  let line = "#888";
  let bg = "transparent";
  let listening = false;
  let taps = null; // { from, mono, left, right }
  const levels = { t: new Uint8Array(1024), l: new Uint8Array(1024), r: new Uint8Array(1024) };

  const tapOutput = () => {
    const from = S.getSuperdoughAudioController?.()?.output?.destinationGain;
    if (!from) return null;
    if (taps?.from === from) return taps;
    const ctx = from.context;
    const analyser = () => Object.assign(ctx.createAnalyser(), { fftSize: 1024, smoothingTimeConstant: 0 });
    const split = ctx.createChannelSplitter(2);
    taps = { from, mono: analyser(), left: analyser(), right: analyser() };
    from.connect(taps.mono);
    from.connect(split);
    split.connect(taps.left, 0);
    split.connect(taps.right, 1);
    return taps;
  };

  // Timers, not animation frames: they keep running while the window is out of view.
  setInterval(() => {
    const t = tapOutput();
    if (!t) return;
    t.mono.getByteTimeDomainData(levels.t);
    if (listening) {
      t.left.getByteTimeDomainData(levels.l);
      t.right.getByteTimeDomainData(levels.r);
      post({ type: "levels", t: levels.t, l: levels.l, r: levels.r });
    }
  }, 1000 / 60);

  const draw = () => {
    const dpr = devicePixelRatio || 1;
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (canvas.width !== w || canvas.height !== h) Object.assign(canvas, { width: w, height: h });
    g.clearRect(0, 0, w, h);
    // An opaque origin's frame is never see-through on a page of another color scheme: paint the window's well.
    g.fillStyle = bg;
    g.fillRect(0, 0, w, h);
    g.strokeStyle = line;
    g.lineWidth = 1.5 * dpr;
    g.beginPath();
    const d = levels.t;
    for (let i = 0; i < d.length; i++) {
      const x = (i / (d.length - 1)) * w, y = h / 2 + ((d[i] - 128) / 128) * (h / 2) * 0.9;
      i ? g.lineTo(x, y) : g.moveTo(x, y);
    }
    g.stroke();
    requestAnimationFrame(draw);
  };
  requestAnimationFrame(draw);

  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "eval" && typeof m.code === "string") void run(m.id, m.code);
    else if (m.type === "stop") void ready.then(() => S.hush());
    else if (m.type === "pause") void ready.then((repl) => repl.scheduler.pause());
    else if (m.type === "resume") void ready.then((repl) => repl.scheduler.start());
    else if (m.type === "listen") listening = !!m.on;
    else if (m.type === "colors") {
      if (typeof m.line === "string") line = m.line;
      if (typeof m.bg === "string") bg = m.bg;
    }
  });
  addEventListener("pointerdown", (e) => e.button === 0 && post({ type: "press" }), true);
  addEventListener("contextmenu", (e) => (e.preventDefault(), post({ type: "contextmenu" })));

  void ready.then(() => {
    const sounds = Object.keys(S.soundMap?.get?.() ?? {}).sort();
    post({ type: "ready", sounds });
  });
})();
