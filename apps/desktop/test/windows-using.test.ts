import { describe, expect, it } from "vitest";
import type { AppWindow, Pane } from "@cmd/protocol";
import { windowsUsing } from "../src/renderer/src/model.ts";

const pane = (title: string, cwd: string, exitCode: number | null = null) => ({ title, cwd, exitCode }) as Pane;
const win = (title: string, path?: string) => ({ title, state: path === undefined ? {} : { path } }) as unknown as AppWindow;

describe("windows using a path (before moving it)", () => {
  it("finds terminals in it, and windows showing it or something in it", () => {
    const panes = [pane("zsh", "/p/src/app"), pane("claude", "/p/srcs"), pane("old", "/p/src", 0)];
    const windows = [win("notes.md", "/p/src/notes.md"), win("box", "/p/box"), win("blank")];
    expect(windowsUsing(["/p/src"], panes, windows)).toEqual(["zsh", "notes.md"]);
    expect(windowsUsing(["/p/box/a.txt"], panes, windows)).toEqual([]);
    expect(windowsUsing(["/p/box", "/p/srcs"], panes, windows)).toEqual(["claude", "box"]);
  });
});
