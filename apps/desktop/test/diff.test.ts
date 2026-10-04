import { describe, expect, it } from "vitest";
import { parseDiff } from "../src/renderer/src/diff.ts";

const DIFF = `diff --git a/a.txt b/a.txt
index 5626abf..f719efd 100644
--- a/a.txt
+++ b/a.txt
@@ -1,2 +1,2 @@
 one
-two
+TWO
diff --git a/gone.txt b/gone.txt
deleted file mode 100644
--- a/gone.txt
+++ /dev/null
@@ -1 +0,0 @@
-bye
diff --git a/old name.txt b/new name.txt
similarity index 100%
rename from old name.txt
rename to new name.txt
diff --git a/logo.png b/logo.png
Binary files a/logo.png and b/logo.png differ
`;

describe("parseDiff", () => {
  it("splits a unified diff by file, counting lines, with deletes, renames and binaries", () => {
    const d = parseDiff(DIFF);
    expect([...d.keys()]).toEqual(["a.txt", "gone.txt", "new name.txt", "logo.png"]);
    expect(d.get("a.txt")).toMatchObject({ added: 1, removed: 1, lines: ["@@ -1,2 +1,2 @@", " one", "-two", "+TWO"] });
    expect(d.get("gone.txt")).toMatchObject({ added: 0, removed: 1 });
    expect(d.get("new name.txt")).toMatchObject({ lines: [], added: 0 });
    expect(d.get("logo.png")!.binary).toBe(true);
    expect(parseDiff("").size).toBe(0);
  });
});
