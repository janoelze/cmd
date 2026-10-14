// The API reference in packages/widget-api/README.md and on the website's widgets page is
// what `pnpm widget-api:docs` (scripts/widget-api-docs.ts) makes of the d.ts now: a JSDoc, a
// prop or a verb changed without running it fails here.

import fs from "node:fs";
import { describe, expect, it } from "vitest";
import { API_ELEMENTS, API_VERBS } from "@cmd/protocol/widget-tree";
import { README, WEBSITE, reference, websitePage, withReference } from "../../../scripts/widget-api-docs.ts";

describe("the API reference", () => {
  const ref = reference();

  it("is current in the README (pnpm widget-api:docs)", () => {
    const readme = fs.readFileSync(README, "utf8");
    expect(withReference(readme, ref) === readme, "packages/widget-api/README.md is stale: run pnpm widget-api:docs").toBe(true);
  });

  it("is current on the website (website/public/widgets, pnpm widget-api:docs)", () => {
    const page = fs.existsSync(WEBSITE) ? fs.readFileSync(WEBSITE, "utf8") : "";
    expect(page === websitePage(ref), "website/public/_lib/widget-api.html is stale: run pnpm widget-api:docs").toBe(true);
    for (const v of API_VERBS) expect(page, v).toContain(`cmd.${v}(`);
    for (const e of Object.keys(API_ELEMENTS)) expect(page, e).toContain(`<h4 id="${e.toLowerCase()}"><code>${e}</code></h4>`);
    expect(page).toMatch(/<code>cmd\.agents\.list\(.*<\/code><\/td><td>1\.0<\/td><td><code>workspace: \[&quot;read&quot;\]<\/code>/);
  });

  it("has every verb with its permission, and every element", () => {
    for (const v of API_VERBS) expect(ref, v).toContain(`cmd.${v}(`);
    for (const e of Object.keys(API_ELEMENTS)) expect(ref, e).toContain(`#### \`${e}\``);
    expect(ref).toMatch(/`cmd\.agents\.list\(.*\| 1\.0 \| `workspace: \["read"\]`/);
    expect(ref).toMatch(/`cmd\.net\.fetch\(.*\| `net: \[<host>\]`/);
  });
});
