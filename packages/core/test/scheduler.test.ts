import { describe, expect, it } from "vitest";
import { Scheduler, STALL_MS } from "../src/scheduler.ts";

const burn = (ms: number) => {
  const end = performance.now() + ms;
  while (performance.now() < end);
};

describe("scheduler", () => {
  it("lets a long job take only its share of the time", async () => {
    const s = new Scheduler({ budgetMs: 10, share: 0.25, watchdog: false });
    const t0 = performance.now();
    // 100 ms of work in 2 ms steps: at a quarter share it needs about 400 ms of wall time.
    for (let i = 0; i < 50; i++) {
      burn(2);
      await s.yield();
    }
    const wall = performance.now() - t0;
    // No upper bound: a busy CI runner stretches wall time arbitrarily (1.8 s seen), which says nothing about the share.
    expect(wall).toBeGreaterThan(250);
  });

  it("runs startup jobs in order, one per tick, and reports the phase", async () => {
    const s = new Scheduler({ watchdog: false });
    const seen: string[] = [];
    const phases: string[] = [];
    s.on("startup", (st) => phases.push(`${st.phase}:${st.tasks.map((t) => t.id).join(",")}`));
    s.startup("a", "A", () => void seen.push("a"));
    s.startup("b", "B", async () => {
      await new Promise((r) => setTimeout(r, 5));
      seen.push("b");
    });
    s.startup("c", "C", () => {
      throw new Error("boom"); // a failing job doesn't stop the rest
    });
    s.startup("d", "D", () => void seen.push("d"));
    s.ready();
    expect(seen).toEqual([]); // nothing runs on the caller's tick: the socket answers first
    expect(s.status()).toMatchObject({ phase: "starting", tasks: [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }] });
    await s.idle();
    expect(seen).toEqual(["a", "b", "d"]);
    expect(s.status()).toMatchObject({ phase: "ready", tasks: [] });
    expect(phases.at(-1)).toBe("ready:");
  });

  it("notices a blocked thread and blames the activity that was running", async () => {
    const s = new Scheduler({});
    try {
      const stalls: { ms: number; in: string }[] = [];
      s.on("stall", (st) => stalls.push(st));
      await new Promise((r) => setTimeout(r, 60)); // the watchdog's timer is running
      const done = s.mark("rpc test.block");
      burn(STALL_MS + 80);
      done();
      await new Promise((r) => setTimeout(r, 120));
      expect(stalls.length).toBeGreaterThanOrEqual(1);
      expect(stalls[0]!.ms).toBeGreaterThanOrEqual(STALL_MS);
      expect(stalls[0]!.in).toBe("rpc test.block");
      expect(s.longestStall()).toBe(Math.max(...stalls.map((x) => x.ms)));
      // A request answered in the middle of a job hands the name back to the job.
      const endJob = s.mark("job");
      s.mark("rpc core.info")();
      burn(STALL_MS + 40);
      await new Promise((r) => setTimeout(r, 120));
      endJob();
      expect(stalls.at(-1)!.in).toBe("job");
    } finally {
      s.dispose();
    }
  });
});
