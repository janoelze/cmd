// A file's icon in the Files window: its viewer's (from the core's own window types), else what it holds.

import { beforeAll, describe, expect, it } from "vitest";
import { WindowTypes } from "../../../packages/core/src/windows/types.ts";
import { registerBuiltins } from "../../../packages/core/src/windows/builtin.ts";
import { fileIcon, setWindowTypes } from "../src/renderer/src/windows/registry.ts";

beforeAll(() => {
  const types = new WindowTypes();
  registerBuiltins(types);
  setWindowTypes(types.info());
});

describe("fileIcon", () => {
  it("takes the icon of the viewer that opens the file", () => {
    expect(fileIcon("clip.MP4")).toBe("film-strip");
    expect(fileIcon("shot.png")).toBe("image");
    expect(fileIcon("paper.pdf")).toBe("article");
    expect(fileIcon("cmd.sqlite")).toBe("database");
    expect(fileIcon("package.json")).toBe("brackets-curly");
    expect(fileIcon("beat.strudel")).toBe("music-note");
  });

  it("knows what no viewer opens by what it holds, and the browser's claim on HTML doesn't count", () => {
    expect(fileIcon("song.mp3")).toBe("waveform");
    expect(fileIcon("film.mkv")).toBe("film-strip");
    expect(fileIcon("dist.tar.gz")).toBe("file-zip");
    expect(fileIcon("Inter.woff2")).toBe("text-aa");
    expect(fileIcon("index.html")).toBe("file-text");
    expect(fileIcon("main.ts")).toBe("file-text");
    expect(fileIcon("Makefile")).toBe("file");
    expect(fileIcon("blob.bin")).toBe("file");
  });
});
