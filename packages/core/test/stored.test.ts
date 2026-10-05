// Stored documents from other cmd versions (stored.ts): decoded, never cast.
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { decodeAgent, decodeDoc, decodeRows, decodeTurn, decoder } from "../src/stored.ts";

describe("decoder", () => {
  const decode = decoder<{ id: string; tags: string[]; note: string | null; n: number; extra?: string }>({ id: "", tags: [], note: null, n: 0 }, ["id"]);

  it("fills in missing fields and replaces ones of another kind", () => {
    expect(decode({ id: "a", tags: "x", n: "3" })).toEqual({ id: "a", tags: [], note: null, n: 0 });
  });

  it("keeps fields it doesn't know, and optional ones as they are", () => {
    expect(decode({ id: "a", tags: ["t"], note: "hi", n: 1, extra: "e", newer: { x: 1 } })).toEqual({ id: "a", tags: ["t"], note: "hi", n: 1, extra: "e", newer: { x: 1 } });
  });

  it("rejects documents without their required fields, or that aren't objects", () => {
    expect(decode({ tags: [] })).toBeNull();
    expect(decode({ id: 7 })).toBeNull();
    for (const raw of [null, [], "a", 1]) expect(decode(raw)).toBeNull();
  });

  it("gives every document its own defaults", () => {
    const a = decode({ id: "a" })!;
    a.tags.push("x");
    expect(decode({ id: "b" })!.tags).toEqual([]);
  });

  it("skips rows that aren't JSON or can't be decoded, and keeps the rest", () => {
    expect(decodeRows("thing", ['{"id":"a"}', "not json", '{"id":1}', '{"id":"b"}'], decode).map((t) => t.id)).toEqual(["a", "b"]);
    expect(decodeDoc("thing", "{", decode)).toBeNull();
  });
});

describe("stored types", () => {
  it("reads a format 1 turn: no followUps or notes, older file entries", () => {
    const t = decodeTurn({ format: 1, agentId: "a", index: 2, files: [{ path: "x.ts", change: "M" }, { change: "A" }], tools: [{ name: "Bash", count: 2 }, "junk"] })!;
    expect(t).toMatchObject({ followUps: [], notes: [], background: [], inferred: [], files: [{ path: "x.ts", change: "M", via: [] }], tools: [{ name: "Bash", count: 2, failed: 0 }] });
  });

  it("reads an agent saved without newer fields, its turn too", () => {
    const a = decodeAgent({ id: "a", kind: "claude", turn: { agentId: "a", index: 0 } })!;
    expect(a).toMatchObject({ rootId: "a", depth: 0, native: {}, spawn: { source: "detected" }, turn: { notes: [] } });
  });
});

describe("reading stored state", () => {
  // Saved documents are decoded (stored.ts); a cast trusts whatever an older cmd wrote.
  const files = ["store.ts", "agents/activity/log.ts", "agents/homes.ts", "search/index.ts"];
  for (const f of files) {
    it(`${f} doesn't cast parsed documents to their type`, () => {
      const src = fs.readFileSync(path.join(import.meta.dirname, "../src", f), "utf8");
      expect(src.match(/JSON\.parse\([^)]*\)\)? as (?!Record<)\w+/g) ?? []).toEqual([]);
    });
  }
});
