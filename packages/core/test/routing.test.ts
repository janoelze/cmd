import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { routeFor } from "../src/routing.ts";
import { readText, writeText } from "../src/windows.ts";

describe("open routing", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-route-"));
  const f = (name: string, content: string | Buffer) => {
    const p = path.join(dir, name);
    fs.writeFileSync(p, content);
    return p;
  };

  it("sends folders to files, web/image/pdf to the browser, text to text windows", () => {
    expect(routeFor(dir)).toBe("files");
    expect(routeFor(f("page.html", "<p>hi</p>"))).toBe("browser");
    expect(routeFor(f("shot.PNG", Buffer.from([0x89, 0x50, 0x4e, 0x47, 0])))).toBe("browser");
    expect(routeFor(f("notes.md", "# hi"))).toBe("text");
    expect(routeFor(f("Makefile", "all:\n\techo"))).toBe("text");
    expect(routeFor(f("README", "plain text, no extension"))).toBe("text");
    expect(routeFor(f("empty.bin", ""))).toBe("text");
  });

  it("leaves binaries and missing paths to the default app", () => {
    expect(routeFor(f("app.bin", Buffer.from([1, 2, 0, 3])))).toBeNull();
    expect(routeFor(path.join(dir, "missing.txt"))).toBeNull();
  });

  it("reads and saves text, refusing to overwrite outside changes", () => {
    const p = f("edit.txt", "one");
    const r = readText(p);
    expect(r).toMatchObject({ text: "one", truncated: false, binary: false });
    const w = writeText(p, "two", r.mtime);
    expect(fs.readFileSync(p, "utf8")).toBe("two");
    fs.utimesSync(p, new Date(), new Date(Date.now() + 5000)); // changed elsewhere
    expect(() => writeText(p, "three", w.mtime)).toThrow(/changed on disk/);
  });
});
