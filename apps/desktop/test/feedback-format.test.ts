import os from "node:os";
import { describe, expect, it } from "vitest";
import { feedbackPayload } from "../src/main/feedback-format.ts";

describe("feedbackPayload", () => {
  it("makes a Discord embed without pings or the user's home", () => {
    const home = os.homedir();
    const p = feedbackPayload(
      { kind: "bug", message: `  @everyone it broke in ${home}/src/x  `, contact: " me@example.com ", context: { version: "1.2.3", platform: "darwin" } },
      new Date(0),
    ) as any;
    expect(p.allowed_mentions).toEqual({ parse: [] });
    const e = p.embeds[0];
    expect(e.title).toBe("Bug");
    expect(e.description).toBe("@everyone it broke in ~/src/x");
    expect(e.fields[0]).toEqual({ name: "Contact", value: "me@example.com", inline: false });
    expect(e.fields.map((f: any) => f.name)).toEqual(["Contact", "version", "platform"]);
    expect(e.timestamp).toBe("1970-01-01T00:00:00.000Z");
  });

  it("leaves out what wasn't given and clips long messages", () => {
    const e = (feedbackPayload({ kind: "idea", message: "x".repeat(5000) }) as any).embeds[0];
    expect(e.fields).toEqual([]);
    expect(e.description.length).toBe(4000);
  });
});
