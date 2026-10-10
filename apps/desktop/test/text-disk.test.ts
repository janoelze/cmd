import { describe, expect, it } from "vitest";
import { diskChange } from "../src/renderer/src/editor/disk.ts";

describe("text window: the file changed on disk", () => {
  it("reloads an agent's write right after ⌘S, even when the save's stat saw that write", () => {
    // CI 38064616592: ⌘S wrote "# hi there", the agent wrote at once, the save's stat
    // returned the agent's mtime, and the one coalesced fs.changed was taken for the save.
    expect(diskChange("# changed by an agent\n", "# hi there", "# hi there", false)).toBe("reload");
  });
  it("ignores its own save", () => {
    expect(diskChange("# hi there", "# hi there", "# hi there", false)).toBe("clean");
    // The echo arrives before the save's answer: the disk already has the buffer.
    expect(diskChange("# hi there", "# hi there", "# hi", true)).toBe("clean");
  });
  it("keeps unsaved edits when the disk still has what was saved", () => {
    expect(diskChange("# hi", "# hi there", "# hi", true)).toBe("unchanged");
  });
  it("asks when someone else wrote and there are unsaved edits", () => {
    expect(diskChange("# changed", "# hi there", "# hi", true)).toBe("conflict");
  });
});
