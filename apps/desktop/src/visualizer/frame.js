// The page a Visualizer window runs in (cmd-visualizer://frame/, main/visualizer.ts):
// butterchurn drawing MilkDrop presets on a canvas that fills the frame. Presets
// are code (butterchurn compiles their equations with new Function), so this
// runs sandboxed in its own opaque origin, under a CSP with no network, never in
// the app's page. It hears no audio itself: the window (VisualizerView) posts
// what its source sounds like, 1024 samples a frame, as butterchurn's audioLevels.
//
// In:  { type: "init", sampleRate }, { type: "preset", name, blend },
//      { type: "audio", t, l, r } (Uint8Array, 128 = silence), { type: "active", active }
// Out: { type: "ready", presets }, { type: "preset", name }, { type: "press" },
//      { type: "contextmenu" }, { type: "error", message }

(() => {
  const B = window.butterchurn.default ?? window.butterchurn;
  const P = window.butterchurnPresets.default ?? window.butterchurnPresets;
  const presets = P.getPresets();
  const names = Object.keys(presets).sort((a, b) => a.localeCompare(b));
  const post = (m) => parent.postMessage(m, "*");

  const canvas = document.createElement("canvas");
  document.body.append(canvas);
  const silence = new Uint8Array(1024).fill(128);
  let levels = { timeByteArray: silence, timeByteArrayL: silence, timeByteArrayR: silence };
  let viz = null;
  let active = true;
  let frame = 0;

  const size = () => {
    const dpr = window.devicePixelRatio || 1;
    const w = Math.max(1, Math.round(innerWidth * dpr)), h = Math.max(1, Math.round(innerHeight * dpr));
    canvas.width = w;
    canvas.height = h;
    viz?.setRendererSize(w, h);
  };

  const draw = () => {
    frame = 0;
    if (!viz || !active) return;
    try {
      viz.render({ audioLevels: levels });
    } catch (err) {
      post({ type: "error", message: String(err?.message ?? err) });
    }
    frame = requestAnimationFrame(draw);
  };
  const run = () => void (frame || (frame = requestAnimationFrame(draw)));

  const load = (name, blend) => {
    const preset = presets[name] ?? presets[names[Math.floor(Math.random() * names.length)]];
    if (!viz || !preset) return;
    try {
      viz.loadPreset(preset, blend);
      post({ type: "preset", name: names.find((n) => presets[n] === preset) });
    } catch (err) {
      post({ type: "error", message: String(err?.message ?? err) });
    }
  };

  addEventListener("message", (e) => {
    if (e.source !== parent || !e.data || typeof e.data !== "object") return;
    const m = e.data;
    if (m.type === "init" && !viz) {
      size();
      // An offline context: butterchurn wants one for its analysers, which go unused (audioLevels).
      const ctx = new OfflineAudioContext(2, 1, m.sampleRate || 48000);
      viz = B.createVisualizer(ctx, canvas, { width: canvas.width, height: canvas.height, pixelRatio: 1 });
      run();
    } else if (m.type === "preset") load(m.name, typeof m.blend === "number" ? m.blend : 2);
    else if (m.type === "audio" && m.t instanceof Uint8Array) levels = { timeByteArray: m.t, timeByteArrayL: m.l, timeByteArrayR: m.r };
    else if (m.type === "active") {
      active = !!m.active;
      if (active) run();
    }
  });
  addEventListener("resize", size);
  addEventListener("pointerdown", (e) => e.button === 0 && post({ type: "press" }), true);
  addEventListener("contextmenu", (e) => (e.preventDefault(), post({ type: "contextmenu" })));
  post({ type: "ready", presets: names });
})();
