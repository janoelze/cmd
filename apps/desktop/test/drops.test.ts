import { describe, expect, it, vi } from "vitest";

vi.mock("../src/renderer/src/bridge.ts", () => ({ cmd: {} }));
vi.mock("../src/renderer/src/actions.ts", () => ({ openPath: vi.fn() }));
const { dropOpens } = await import("../src/renderer/src/drops.ts");

// Dropped files and links that open in their default app: who chose them (renderer/src/drops.ts).

describe("dropOpens", () => {
  it("a real file dragged from Finder is the person's choice", () => {
    expect(dropOpens({ files: ["/Applications/Calculator.app", "/tmp/deploy.command"], picked: ["/Applications/Calculator.app", "/tmp/deploy.command"], urls: [], text: "" })).toEqual([
      { target: "/Applications/Calculator.app", from: "user" },
      { target: "/tmp/deploy.command", from: "user" },
    ]);
  });

  it("links a page dropped, URLs and file: links alike, are content", () => {
    expect(dropOpens({ files: ["/tmp/deploy.command"], picked: [], urls: ["smb://host/share", "https://example.com"], text: "" })).toEqual([
      { target: "/tmp/deploy.command", from: "content" },
      { target: "smb://host/share", from: "content" },
      { target: "https://example.com", from: "content" },
    ]);
  });
});
