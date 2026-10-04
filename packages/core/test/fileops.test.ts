import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPath, duplicatePath, renamePath } from "../src/fileops.ts";
import { rmTemp } from "./tmp.ts";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-fileops-"));
const at = (rel: string) => path.join(dir, rel);

describe("file operations", () => {
  afterAll(() => rmTemp(dir));

  it("creates untitled files and folders without overwriting", () => {
    expect(createPath(dir, "file")).toBe(at("untitled"));
    expect(createPath(dir, "file")).toBe(at("untitled 2"));
    expect(createPath(dir, "dir")).toBe(at("untitled folder"));
    expect(fs.statSync(at("untitled folder")).isDirectory()).toBe(true);
  });

  it("duplicates Finder-style, keeping the extension at the end", () => {
    fs.writeFileSync(at("a.txt"), "hi");
    expect(duplicatePath(at("a.txt"))).toBe(at("a copy.txt"));
    expect(duplicatePath(at("a.txt"))).toBe(at("a copy 2.txt"));
    expect(fs.readFileSync(at("a copy 2.txt"), "utf8")).toBe("hi");
    fs.writeFileSync(at(".env"), "x");
    expect(duplicatePath(at(".env"))).toBe(at(".env copy"));
    fs.mkdirSync(at("d.v1"));
    fs.writeFileSync(at("d.v1/f"), "1");
    expect(duplicatePath(at("d.v1"))).toBe(at("d.v1 copy"));
    expect(fs.readFileSync(at("d.v1 copy/f"), "utf8")).toBe("1");
  });

  it("renames, refusing taken and invalid names", () => {
    fs.writeFileSync(at("r.txt"), "1");
    fs.writeFileSync(at("taken.txt"), "2");
    expect(() => renamePath(at("r.txt"), "taken.txt")).toThrow(/already exists/);
    expect(() => renamePath(at("r.txt"), "x/y")).toThrow(/not a valid name/);
    expect(renamePath(at("r.txt"), "s.txt")).toBe(at("s.txt"));
    expect(fs.existsSync(at("r.txt"))).toBe(false);
    // Case-only renames work on case-insensitive disks too.
    expect(renamePath(at("s.txt"), "S.txt")).toBe(at("S.txt"));
    expect(fs.readdirSync(dir)).toContain("S.txt");
  });
});
