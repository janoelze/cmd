// The news widget against the fake host: the feed's items, newest first, a click opening
// one, and the parser on what RSS sends.

import { describe, expect, it } from "vitest";
import { render, createHost, type HostData } from "@cmd/widget-api/testing";
import berlin from "../fixtures/berlin.json" with { type: "json" };
import News, { parse } from "./news.tsx";

describe("News", () => {
  it("lists the stories, newest first, and opens one on click", async () => {
    const host = createHost(berlin as HostData);
    const tree = await render(<News />, host);
    expect(tree.find("Window").props.status).toBe("2 stories");
    expect(tree.rows().map((r) => JSON.stringify(r).match(/"title":"([^"]+)"/)?.[1])).toEqual(["U-Bahn line U5 to run all night", "Senate agrees on the 2027 budget"]);
    await tree.press(tree.rows()[0]!);
    expect(host.calls).toContainEqual(["windows.open", "https://news.example/u5"]);
  });

  it("decodes entities and drops the source from titles", () => {
    const [s] = parse("<item><title>Cats &amp; dogs - The Paper</title><link>https://x.example/a</link><pubDate>Tue, 14 Oct 2026 08:00:00 GMT</pubDate><source url=\"https://x.example\">The Paper</source></item>");
    expect(s).toMatchObject({ title: "Cats & dogs", source: "The Paper", link: "https://x.example/a" });
  });
});
