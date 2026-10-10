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
      // A loaded machine can stall this process on its own while it waits: only stalls
      // from after the mark count, and the first of them is the one the burn caused.
      let from = stalls.length;
      const done = s.mark("rpc test.block");
      burn(STALL_MS + 80);
      done();
      await new Promise((r) => setTimeout(r, 120));
      expect(stalls.length).toBeGreaterThan(from);
      expect(stalls[from]!.ms).toBeGreaterThanOrEqual(STALL_MS);
      expect(stalls[from]!.in).toBe("rpc test.block");
      expect(s.longestStall()).toBe(Math.max(...stalls.map((x) => x.ms)));
      // A request answered in the middle of a job hands the name back to the job.
      from = stalls.length;
      const endJob = s.mark("job");
      s.mark("rpc core.info")();
      // As long as the first burn: the watchdog's tick may come due up to its 50 ms
      // interval after the burn starts, and only lateness over STALL_MS counts.
      burn(STALL_MS + 80);
      await new Promise((r) => setTimeout(r, 120));
      endJob();
      expect(stalls.length).toBeGreaterThan(from);
      expect(stalls[from]!.in).toBe("job");
    } finally {
      s.dispose();
    }
  });

  it("doesn't blame an activity for what runs while it awaits", async () => {
    const s = new Scheduler({});
    try {
      const stalls: { ms: number; in: string }[] = [];
      s.on("stall", (st) => stalls.push(st));
      await new Promise((r) => setTimeout(r, 60));
      // A marks, then waits; while it waits, B blocks the thread: unmarked, then marked.
      for (const b of [null, "rpc b.block"]) {
        const from = stalls.length;
        const a = (async () => {
          const done = s.mark("journal sync");
          try {
            await new Promise((r) => setTimeout(r, STALL_MS + 300));
          } finally {
            done();
          }
        })();
        await new Promise<void>((r) =>
          setTimeout(() => {
            const done = b ? s.mark(b) : () => {};
            burn(STALL_MS + 80);
            done();
            r();
          }, 20),
        );
        await a;
        expect(stalls.length).toBeGreaterThan(from);
        // A loaded machine may stall on its own as well: none of them is A's.
        expect(stalls.slice(from).map((x) => x.in)).not.toContain("journal sync");
        expect(stalls.slice(from).map((x) => x.in)).toContain(b ?? "(idle: timers, I/O callbacks)");
      }
    } finally {
      s.dispose();
    }
  });

  it("names a job again after each yield, and only its steps", async () => {
    const s = new Scheduler({ budgetMs: 5, share: 0.5 });
    try {
      const stalls: { ms: number; in: string }[] = [];
      s.on("stall", (st) => stalls.push(st));
      await new Promise((r) => setTimeout(r, 60));
      const from = stalls.length;
      const done = s.mark("sessions rebuild");
      let other: Promise<void> | null = null;
      for (let i = 0; i < 4; i++) {
        // While the job pauses (it ran past its budget), an unmarked timer blocks: not the job's.
        if (i === 1) other = new Promise((r) => setTimeout(() => (burn(STALL_MS + 80), r()), 0));
        burn(i === 3 ? STALL_MS + 80 : 6); // its last step blocks: the job's
        await s.yield();
      }
      done();
      await other;
      await new Promise((r) => setTimeout(r, 120));
      const blamed = stalls.slice(from).map((x) => x.in);
      expect(blamed).toContain("(idle: timers, I/O callbacks)");
      expect(blamed.at(-1)).toBe("sessions rebuild");
    } finally {
      s.dispose();
    }
  });
});
