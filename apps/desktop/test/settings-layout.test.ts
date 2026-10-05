import { describe, expect, it } from "vitest";
import { SECRETS, SETTINGS_SCHEMA } from "@cmd/protocol";
import { PLACED_ELSEWHERE, SETTINGS_PAGES, itemKey } from "../src/renderer/src/settings/layout.ts";

describe("settings layout", () => {
  it("places every setting and secret exactly once", () => {
    const placed = [...SETTINGS_PAGES.flatMap((p) => p.sections.flatMap((s) => s.items.map(itemKey))), ...PLACED_ELSEWHERE];
    expect([...placed].sort()).toEqual([...Object.keys(SETTINGS_SCHEMA), ...Object.keys(SECRETS)].sort());
  });

  // A row's description is one line you read at a glance; the rest goes in `details` (the info button).
  it("keeps descriptions to one short line", () => {
    const long = Object.entries({ ...SETTINGS_SCHEMA, ...SECRETS })
      .map(([k, d]) => [k, d.description] as const)
      .filter(([, t]) => t.length > 70);
    expect(long).toEqual([]);
  });
});
