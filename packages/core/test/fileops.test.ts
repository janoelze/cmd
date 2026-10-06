import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { createPath, duplicatePath, protectedReason, renamePath, transferPaths } from "../src/fileops.ts";
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

  it("copies and moves into a folder, never overwriting", () => {
    fs.mkdirSync(at("t/in"), { recursive: true });
    fs.mkdirSync(at("t/to"));
    fs.writeFileSync(at("t/in/a.txt"), "a");
    fs.writeFileSync(at("t/to/a.txt"), "taken");
    fs.mkdirSync(at("t/in/sub"));
    fs.writeFileSync(at("t/in/sub/f"), "f");
    expect(transferPaths([at("t/in/a.txt"), at("t/in/sub")], at("t/to"), "copy")).toEqual([at("t/to/a 2.txt"), at("t/to/sub")]);
    expect(fs.readFileSync(at("t/to/a.txt"), "utf8")).toBe("taken");
    expect(fs.readFileSync(at("t/to/sub/f"), "utf8")).toBe("f");
    expect(fs.existsSync(at("t/in/a.txt"))).toBe(true);
    expect(transferPaths([at("t/in/a.txt")], at("t/to"), "move")).toEqual([at("t/to/a 3.txt")]);
    expect(fs.existsSync(at("t/in/a.txt"))).toBe(false);
    // Moving where it already is: nothing happens.
    expect(transferPaths([at("t/in/sub")], at("t/in"), "move")).toEqual([at("t/in/sub")]);
    // auto: the same disk, so a move.
    expect(transferPaths([at("t/in/sub")], at("t/to"), "auto")).toEqual([at("t/to/sub 2")]);
    expect(fs.existsSync(at("t/in/sub"))).toBe(false);
  });

  it("refuses a folder into itself, and missing paths, before touching anything", () => {
    fs.mkdirSync(at("u/d/inner"), { recursive: true });
    fs.writeFileSync(at("u/f"), "f");
    expect(() => transferPaths([at("u/f"), at("u/d")], at("u/d/inner"), "move")).toThrow(/itself/);
    expect(() => transferPaths([at("u/f"), at("u/nope")], at("u/d"), "copy")).toThrow(/“nope” isn't there anymore/);
    expect(fs.existsSync(at("u/f"))).toBe(true);
    expect(fs.existsSync(at("u/d/f"))).toBe(false);
  });

  it("keeps system and home folders where they are", () => {
    const home = "/Users/me";
    for (const p of ["/", "/Applications", "/Users", "/private/tmp", "/Volumes/Backup", "/Users/me", "/Users/other", "/Users/me/Documents", "/Users/me/Library", "/Users/me/.ssh"])
      expect(protectedReason(p, home), p).not.toBeNull();
    for (const p of ["/Users/me/src", "/Users/me/Documents/notes.txt", "/Users/me/src/.env", "/Volumes/Backup/photos", "/tmp/x"])
      expect(protectedReason(p, home), p).toBeNull();
    expect(protectedReason("/Users/me/Documents", home)).toBe("macOS and your apps expect “Documents” where it is.");
    // Copying one is fine; a home or a disk isn't copied either.
    expect(() => transferPaths([os.homedir()], dir, "copy")).toThrow(/home folder/);
  });
});
