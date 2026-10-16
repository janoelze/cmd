// What the phone types (keys.ts): sticky modifiers, held arrows, the compose bar's text
// then Return after a pause (an agent TUI takes a burst as a paste), and the links and
// words a finger lands on.
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REPEAT_DELAY, REPEAT_EVERY, Repeater, SUBMIT_DELAY, compose, linkAt, modified, withCtrl, wordAt } from "../src/keys.ts";

describe("modifiers", () => {
  it("ctrl makes control characters, alt puts ESC first, both: ESC then the control character", () => {
    expect(withCtrl("c")).toBe("\x03");
    expect(withCtrl("[")).toBe("\x1b");
    expect(withCtrl("ab")).toBe("ab");
    expect(modified("b", { ctrl: false, alt: true })).toBe("\x1bb");
    expect(modified("x", { ctrl: true, alt: true })).toBe("\x1b\x18");
    expect(modified("\x1b[D", { ctrl: false, alt: true })).toBe("\x1b\x1b[D");
    expect(modified("q", { ctrl: false, alt: false })).toBe("q");
  });
});

describe("timed input", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("a held arrow types once, again after the delay, then steadily until let go", () => {
    const sent: string[] = [];
    const r = new Repeater((d) => sent.push(d));
    r.press("↑");
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(REPEAT_DELAY - 1);
    expect(sent).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sent).toHaveLength(2);
    vi.advanceTimersByTime(REPEAT_EVERY * 5);
    expect(sent).toHaveLength(7);
    r.release();
    vi.advanceTimersByTime(REPEAT_EVERY * 10);
    expect(sent).toHaveLength(7);
  });

  it("a tap (released before the delay) types once", () => {
    const sent: string[] = [];
    const r = new Repeater((d) => sent.push(d));
    r.press("←");
    vi.advanceTimersByTime(100);
    r.release();
    vi.advanceTimersByTime(REPEAT_DELAY * 2);
    expect(sent).toEqual(["←"]);
  });

  it("compose writes the text, waits for the Mac to take it, pauses, then Return on its own", async () => {
    const writes: { data: string; at: number }[] = [];
    let ack!: () => void;
    const write = (data: string) => {
      writes.push({ data, at: Date.now() });
      return new Promise<void>((r) => (ack = r));
    };
    const done = compose(write, "fix the test", true);
    expect(writes.map((w) => w.data)).toEqual(["fix the test"]);
    // The Mac's reply takes a while: no Return before it, however long.
    await vi.advanceTimersByTimeAsync(500);
    expect(writes).toHaveLength(1);
    ack();
    await vi.advanceTimersByTimeAsync(SUBMIT_DELAY - 1);
    expect(writes).toHaveLength(1);
    await vi.advanceTimersByTimeAsync(1);
    expect(writes.map((w) => w.data)).toEqual(["fix the test", "\r"]);
    expect(writes[1]!.at - writes[0]!.at).toBeGreaterThanOrEqual(SUBMIT_DELAY);
    ack();
    await done;
  });

  it("send without Return writes only the text; an empty compose with Return is just Return", async () => {
    const writes: string[] = [];
    await compose((d) => void writes.push(d), "ls -la", false);
    expect(writes).toEqual(["ls -la"]);
    writes.length = 0;
    const p = compose((d) => void writes.push(d), "", true);
    await vi.runAllTimersAsync();
    await p;
    expect(writes).toEqual(["\r"]);
  });
});

describe("what a finger lands on", () => {
  const line = "see https://example.com/a_(b) and (https://cmd.dev/docs). done";
  it("a link under the column, without the sentence's punctuation, keeping a bracket it opened", () => {
    expect(linkAt(line, 4)).toBe("https://example.com/a_(b)");
    expect(linkAt(line, 28)).toBe("https://example.com/a_(b)");
    expect(linkAt(line, 40)).toBe("https://cmd.dev/docs");
    expect(linkAt(line, 55)).toBeNull();
    expect(linkAt(line, 0)).toBeNull();
  });

  it("a word under the column, nothing on a space", () => {
    expect(wordAt("npm run build", 5)).toEqual([4, 7]);
    expect(wordAt("npm run build", 3)).toBeNull();
    expect(wordAt("path/to/file.ts:12", 6)).toEqual([0, 18]);
  });
});
