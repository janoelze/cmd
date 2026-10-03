import { describe, expect, it } from "vitest";
import { SECRETS, SETTINGS_SCHEMA } from "@cmd/protocol";
import { PLACED_ELSEWHERE, SETTINGS_PAGES, itemKey } from "../src/renderer/src/settings/layout.ts";

describe("settings layout", () => {
  it("places every setting and secret exactly once", () => {
    const placed = [...SETTINGS_PAGES.flatMap((p) => p.sections.flatMap((s) => s.items.map(itemKey))), ...PLACED_ELSEWHERE];
    expect([...placed].sort()).toEqual([...Object.keys(SETTINGS_SCHEMA), ...Object.keys(SECRETS)].sort());
  });
});
