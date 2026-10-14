// CPU profiles for the perf harnesses (latency.mjs, perf.mjs --profile): sample the
// renderer over a stretch and print where its time went, by function (self time), with
// the callers of the top three. Build with CMD_NO_MINIFY=1 pnpm build for readable names.

/** Start sampling `cdp` (a CDP session on the page); the returned function stops and prints. */
export async function startProfile(cdp) {
  await cdp.send("Profiler.enable");
  await cdp.send("Profiler.setSamplingInterval", { interval: 200 });
  await cdp.send("Profiler.start");
  return async (name, per = 1, unit = "run") => {
    const { profile } = await cdp.send("Profiler.stop");
    const dt = new Map(profile.nodes.map((n) => [n.id, 0]));
    profile.samples.forEach((id, i) => dt.set(id, dt.get(id) + (profile.timeDeltas[i] ?? 0)));
    const keyOf = (f) => `${f.functionName || "(anon)"} ${f.url.split("/").pop()}:${f.lineNumber + 1}`;
    const self = new Map();
    for (const n of profile.nodes) {
      if (["(idle)", "(program)", "(root)"].includes(n.callFrame.functionName)) continue;
      const key = keyOf(n.callFrame);
      self.set(key, (self.get(key) ?? 0) + dt.get(n.id) / 1000);
    }
    const total = [...self.values()].reduce((a, b) => a + b, 0);
    console.log(`  profile ${name}: ${Math.round(total / per)} ms of script per ${unit}`);
    const top = [...self].sort((a, b) => b[1] - a[1]).slice(0, 18);
    for (const [k, ms] of top) console.log(`    ${(ms / per).toFixed(1).padStart(6)} ms  ${k}`);
    // Who called the top three: their callers, five frames up, by time.
    const byId = new Map(profile.nodes.map((n) => [n.id, n]));
    const parent = new Map();
    for (const n of profile.nodes) for (const c of n.children ?? []) parent.set(c, n.id);
    const nameOf = (n) => `${n.callFrame.functionName || "(anon)"}:${n.callFrame.lineNumber + 1}`;
    for (const [k] of top.slice(0, 3)) {
      const chains = new Map();
      for (const n of profile.nodes) {
        if (keyOf(n.callFrame) !== k) continue;
        const up = [];
        for (let id = parent.get(n.id); id && up.length < 5; id = parent.get(id)) up.push(nameOf(byId.get(id)));
        const key = up.join(" < ");
        chains.set(key, (chains.get(key) ?? 0) + dt.get(n.id) / 1000);
      }
      console.log(`    ${k} called from:`);
      for (const [c, ms] of [...chains].sort((a, b) => b[1] - a[1]).slice(0, 3)) console.log(`      ${(ms / per).toFixed(1).padStart(6)} ms  ${c}`);
    }
  };
}
