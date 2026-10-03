// Renders apps/desktop/build/icon.svg into the packaged app's icons:
// icon.png (1024, Linux and the dev Dock icon), icon.icns (macOS), icon.ico (Windows).
// Rendered by Electron (Chromium dithers gradients; librsvg bands them).
// macOS only (iconutil). usage: pnpm icons
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createRequire } from "node:module";

const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "apps/desktop/build");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-icons-"));

// 1. Electron renders the SVG at 1024 and scales it down (render.cjs is its main
//    process; a window can't be 16 px, and a downscale is crisper anyway).
const sizes = [16, 24, 32, 48, 64, 128, 256, 512, 1024];
fs.writeFileSync(
  path.join(tmp, "render.cjs"),
  `const { app, BrowserWindow } = require("electron");
const fs = require("fs");
const path = require("path");
app.commandLine.appendSwitch("no-sandbox");
app.setPath("userData", path.join(${JSON.stringify(tmp)}, "electron"));
app.whenReady().then(async () => {
  const svg = ${JSON.stringify(fs.readFileSync(path.join(build, "icon.svg"), "utf8"))};
  const win = new BrowserWindow({ width: 1024, height: 1024, show: false, transparent: true, frame: false, webPreferences: { offscreen: true } });
  const html = '<body style="margin:0;background:transparent"><img width="1024" height="1024" src="data:image/svg+xml;base64,' + Buffer.from(svg).toString("base64") + '"></body>';
  await win.loadURL("data:text/html;base64," + Buffer.from(html).toString("base64"));
  await new Promise((r) => setTimeout(r, 500));
  const img = await win.webContents.capturePage({ x: 0, y: 0, width: 1024, height: 1024 });
  for (const size of ${JSON.stringify(sizes)}) {
    const out = size === img.getSize().width ? img : img.resize({ width: size, height: size, quality: "best" });
    fs.writeFileSync(path.join(${JSON.stringify(tmp)}, size + ".png"), out.toPNG());
  }
  app.quit();
});
`,
);
const electron = createRequire(path.join(root, "apps/desktop/package.json"))("electron");
execFileSync(electron, [path.join(tmp, "render.cjs")], { stdio: "inherit" });
const png = (size) => path.join(tmp, `${size}.png`);

// 2. macOS .icns from an .iconset (16…512 at 1x and 2x).
const iconset = path.join(tmp, "icon.iconset");
fs.mkdirSync(iconset);
for (const s of [16, 32, 128, 256, 512]) {
  fs.copyFileSync(png(s), path.join(iconset, `icon_${s}x${s}.png`));
  fs.copyFileSync(png(s * 2), path.join(iconset, `icon_${s}x${s}@2x.png`));
}
execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(build, "icon.icns")]);

// 3. Windows .ico: PNG-compressed entries, 16…256.
const ico = [16, 24, 32, 48, 64, 128, 256].map((s) => fs.readFileSync(png(s)));
const header = Buffer.alloc(6 + 16 * ico.length);
header.writeUInt16LE(1, 2);
header.writeUInt16LE(ico.length, 4);
let offset = header.length;
ico.forEach((data, i) => {
  const s = [16, 24, 32, 48, 64, 128, 256][i];
  const e = 6 + 16 * i;
  header.writeUInt8(s === 256 ? 0 : s, e);
  header.writeUInt8(s === 256 ? 0 : s, e + 1);
  header.writeUInt16LE(1, e + 4);
  header.writeUInt16LE(32, e + 6);
  header.writeUInt32LE(data.length, e + 8);
  header.writeUInt32LE(offset, e + 12);
  offset += data.length;
});
fs.writeFileSync(path.join(build, "icon.ico"), Buffer.concat([header, ...ico]));

fs.copyFileSync(png(1024), path.join(build, "icon.png"));
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote apps/desktop/build/icon.{png,icns,ico}");
