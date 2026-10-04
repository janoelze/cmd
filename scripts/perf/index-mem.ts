// Memory profile of a cold transcript index (docs/14-performance.md): runs one
// indexPass over the real transcript folders into a throwaway database and logs
// RSS and heap as it goes.  node --no-warnings --expose-gc scripts/perf/index-mem.ts
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { indexPass, openIndex } from "../../packages/core/src/search/index.ts";
import { registerBuiltinSources } from "../../packages/core/src/search/builtin.ts";
import { locateContext, TranscriptSources } from "../../packages/core/src/search/sources.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-index-"));
const sources = registerBuiltinSources(new TranscriptSources());
const roots = sources.locate(locateContext(), []);
const db = openIndex(path.join(dir, "search.sqlite"));
const mb = (n: number) => Math.round(n / 1048576);
let peak = 0;
const t0 = performance.now();
const show = (label: string) => {
  const m = process.memoryUsage();
  peak = Math.max(peak, m.rss);
  console.log(`${label.padEnd(14)} rss ${mb(m.rss)} heap ${mb(m.heapUsed)}/${mb(m.heapTotal)} external ${mb(m.external)} ab ${mb(m.arrayBuffers)}  ${Math.round(performance.now() - t0)} ms`);
};
let last = 0;
const r = indexPass(db, roots, sources, (done, total) => {
  if (done - last >= 100 || done === total) (last = done), show(`${done}/${total}`);
});
show("done");
(globalThis as { gc?: () => void }).gc?.();
show("after gc");
db.exec("PRAGMA shrink_memory");
show("shrink_memory");
db.close();
show("db closed");
console.log({ ...r, peakMB: mb(peak), dbMB: mb(fs.statSync(path.join(dir, "search.sqlite")).size) });
fs.rmSync(dir, { recursive: true, force: true });
