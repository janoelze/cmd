// Check a rendered tour for dead time: stretches of tour.mp4 where nothing is
// being done (no input) and nothing on screen changes beyond noise, as a viewer
// sees it (after post's speed-ups and cuts). usage: node experiments/dead-time.mjs <run dir>
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";

const dir = path.resolve(process.argv[2] ?? ".");
const plan = JSON.parse(fs.readFileSync(path.join(dir, "post", "plan.json"), "utf8"));
const events = JSON.parse(fs.readFileSync(path.join(dir, "events.json"), "utf8"));
const meta = JSON.parse(fs.readFileSync(path.join(dir, "meta.json"), "utf8"));
const src = plan.frames.map((f) => f[0]);
const fps = plan.fps;
// Output time of a source time: the first output frame showing it.
const toOut = (s) => {
  let lo = 0, hi = src.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (src[mid] < s) lo = mid + 1;
    else hi = mid;
  }
  return lo / fps;
};
const inputs = events.filter((e) => e.type !== "cursor" && e.type !== "camera").map((e) => ({ u: toOut((e.t - meta.t0) / 1e9), type: e.type }));
const { stderr } = spawnSync("ffmpeg", ["-hide_banner", "-i", path.join(dir, "tour.mp4"), "-vf", "scale=320:-1,freezedetect=n=0.02:d=0.2", "-map", "0:v", "-f", "null", "-"], { encoding: "utf8" });
const frozen = [];
let start = null;
for (const m of stderr.matchAll(/freeze_(start|end): ([\d.]+)/g)) {
  if (m[1] === "start") start = Number(m[2]);
  else if (start !== null) frozen.push([start, Number(m[2])]), (start = null);
}
const length = src.length / fps;
if (start !== null) frozen.push([start, length]);
let dead = 0;
const report = [];
for (const [a, b] of frozen) {
  let s = a;
  for (const x of [...inputs.filter((i) => i.u > a && i.u < b), { u: b }]) {
    if (x.u - s > 0.8) {
      dead += x.u - s;
      const before = inputs.filter((i) => i.u <= s).at(-1);
      report.push(`  ${s.toFixed(1)} s: ${(x.u - s).toFixed(1)} s dead, after ${before?.type ?? "the start"}`);
    }
    s = x.u;
  }
}
console.log(`${path.basename(dir)}: ${length.toFixed(1)} s, ${dead.toFixed(1)} s dead (${Math.round((100 * dead) / length)}%)`);
for (const l of report) console.log(l);
