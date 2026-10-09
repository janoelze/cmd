// The page a Live Code window plays in (cmd-livecode://frame/, main/frames.ts):
// Strudel (@strudel/web) evaluating the window's code and playing it. The frame
// shows nothing (it is 0×0 in the window); while a Visualizer listens it sends
// what it plays as levels. The code is the person's or the AI's, so this runs sandboxed in its own opaque
// origin; it may fetch samples from GitHub and nothing else.
//
// An edit only replaces what plays if it evaluates and its first cycles can be
// queried: a broken edit reports its error and the last good pattern plays on.
//
// In:  { type: "eval", id, code }, { type: "stop" }, { type: "pause" }, { type: "resume" }, { type: "listen", on }
// Out: { type: "ready", sounds }, { type: "evaluated", id, ok, error? }, { type: "state", started, error },
//      { type: "levels", t, l, r }

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

  // ── what it sounds like, for Visualizers ──
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
    const t = listening && tapOutput();
    if (!t) return;
    t.mono.getByteTimeDomainData(levels.t);
    t.left.getByteTimeDomainData(levels.l);
    t.right.getByteTimeDomainData(levels.r);
    post({ type: "levels", t: levels.t, l: levels.l, r: levels.r });
  }, 1000 / 60);

  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "eval" && typeof m.code === "string") void run(m.id, m.code);
    else if (m.type === "stop") void ready.then(() => S.hush());
    else if (m.type === "pause") void ready.then((repl) => repl.scheduler.pause());
    else if (m.type === "resume") void ready.then((repl) => repl.scheduler.start());
    else if (m.type === "listen") listening = !!m.on;
  });

  void ready.then(() => {
    const sounds = Object.keys(S.soundMap?.get?.() ?? {}).sort();
    post({ type: "ready", sounds });
  });
})();
