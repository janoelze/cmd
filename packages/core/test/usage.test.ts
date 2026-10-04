import { describe, expect, it } from "vitest";
import { macosVersion, UsageStats, type UsageBatch } from "../src/usage.ts";

function setup(o: { enabled?: boolean; fail?: boolean; url?: string | null } = {}) {
  const sent: UsageBatch[] = [];
  let now = Date.parse("2026-10-04T12:00:00Z");
  let fail = o.fail ?? false;
  const usage = new UsageStats({
    url: o.url === undefined ? "https://example.test/ingest" : o.url,
    enabled: () => o.enabled ?? true,
    id: () => "install-id",
    version: "1.2.3",
    intervalMs: 0,
    now: () => now,
    fetch: (async (_url: string, init: RequestInit) => {
      if (fail) return new Response("", { status: 503 });
      sent.push(JSON.parse(String(init.body)));
      return new Response(null, { status: 204 });
    }) as typeof fetch,
  });
  return { usage, sent, advance: (ms: number) => (now += ms), setFail: (f: boolean) => (fail = f) };
}

describe("usage stats", () => {
  it("sends counts of known names only, with the app version and platform", async () => {
    const { usage, sent } = setup();
    usage.launch();
    usage.window("terminal");
    usage.window("terminal");
    usage.window("some-plugin");
    usage.agent("claude");
    usage.agent("my-own-agent");
    expect(await usage.flush()).toBe(true);
    expect(sent).toHaveLength(1);
    expect(sent[0]).toMatchObject({ v: 1, id: "install-id", version: "1.2.3", arch: process.arch });
    expect(sent[0]!.counts).toEqual({ "app.launch": 1, "window.terminal": 2, "window.other": 1, "agent.claude": 1, "agent.other": 1 });
    expect(Object.keys(sent[0]!).sort()).toEqual(["arch", "counts", "id", "os", "v", "version"]);
  });

  it("skips empty batches except the first of a day", async () => {
    const { usage, sent, advance } = setup();
    expect(await usage.flush()).toBe(true); // today's
    expect(await usage.flush()).toBe(false);
    usage.launch();
    expect(await usage.flush()).toBe(true);
    advance(24 * 60 * 60_000);
    expect(await usage.flush()).toBe(true);
    expect(sent.map((b) => b.counts)).toEqual([{}, { "app.launch": 1 }, {}]);
  });

  it("keeps the counts when sending fails", async () => {
    const { usage, sent, setFail } = setup({ fail: true });
    usage.window("files");
    expect(await usage.flush()).toBe(false);
    usage.window("files");
    setFail(false);
    expect(await usage.flush()).toBe(true);
    expect(sent[0]!.counts).toEqual({ "window.files": 2 });
  });

  it("counts and sends nothing when off or without an address", async () => {
    for (const o of [{ enabled: false }, { url: null }]) {
      const { usage, sent } = setup(o);
      usage.launch();
      expect(await usage.flush()).toBe(false);
      expect(sent).toEqual([]);
    }
  });

  it("names the macOS version from the Darwin version", () => {
    expect(macosVersion("darwin", "20.6.0")).toBe("11");
    expect(macosVersion("darwin", "24.1.0")).toBe("15");
    expect(macosVersion("darwin", "25.4.0")).toBe("26");
    expect(macosVersion("linux", "6.1")).toBe("linux");
  });
});
