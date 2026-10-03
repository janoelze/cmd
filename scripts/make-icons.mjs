// Builds the app icon from apps/desktop/build/icon.icon, an Icon Composer document
// (icon.json: background fill, a glass layer, specular, shadow). Writes:
//   icon.icon/Assets/glyph.svg  the ⌘ (U+2318), drawn from plain geometry
//   Assets.car  the Liquid Glass icon (light, dark, clear, tinted) for macOS 26+, via actool
//   icon.icns   flat render for older macOS, the DMG and Finder previews, via ictool
//   icon.png    (1024, Linux), icon.ico (Windows)
// and a red variant for development builds (pnpm dev, pnpm dist) in build/dev/
// (Assets.car, icon.icns, icon.png, icon.ico), so they're easy to tell from the installed app.
// The outputs are committed, so packaging needs no Xcode. Needs Xcode 26+. usage: pnpm icons
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

const root = path.resolve(import.meta.dirname, "..");
const build = path.join(root, "apps/desktop/build");
const source = path.join(build, "icon.icon");
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "cmd-icons-"));
const developer = execFileSync("xcode-select", ["-p"], { encoding: "utf8" }).trim();
const ictool = path.join(developer, "../Applications/Icon Composer.app/Contents/Executables/ictool");
// ictool/actool chatter about CoreSimulator on stderr; only show it when they fail.
const run = (cmd, args) => execFileSync(cmd, args, { stdio: ["ignore", "ignore", "pipe"] });

// 1. The glyph: a centre square with half-side a, its sides extended into four
//    270° loops of radius a, stroked h either side. Icon Composer ignores SVG
//    strokes, so it is filled outlines: four bars, and four annular arcs drawn as
//    90° steps (unambiguous, unlike one large-arc flag).
const a = 72, h = 27, R = a + h, r = a - h, edge = 2 * a + R;
const f = (n) => +n.toFixed(3);
const pt = (cx, cy, rad, deg) => `${f(cx + rad * Math.cos((deg * Math.PI) / 180))} ${f(cy + rad * Math.sin((deg * Math.PI) / 180))}`;
let d = "";
for (const s of [1, -1]) d += `M${s * a - h} ${-2 * a}H${s * a + h}V${2 * a}H${s * a - h}Z`;
for (const s of [1, -1]) d += `M${-2 * a} ${s * a - h}H${2 * a}V${s * a + h}H${-2 * a}Z`;
for (const sx of [1, -1]) {
  for (const sy of [1, -1]) {
    const cx = 2 * a * sx, cy = 2 * a * sy;
    const start = (Math.atan2(-sy, -sx) * 180) / Math.PI + 45; // the open quadrant faces the centre
    d += `M${pt(cx, cy, R, start)}`;
    for (let k = 1; k <= 3; k++) d += `A${R} ${R} 0 0 1 ${pt(cx, cy, R, start + 90 * k)}`;
    d += `L${pt(cx, cy, r, start + 270)}`;
    for (let k = 2; k >= 0; k--) d += `A${r} ${r} 0 0 0 ${pt(cx, cy, r, start + 90 * k)}`;
    d += "Z";
  }
}
fs.writeFileSync(
  path.join(source, "Assets/glyph.svg"),
  `<svg xmlns="http://www.w3.org/2000/svg" width="${2 * edge}" height="${2 * edge}" viewBox="${-edge} ${-edge} ${2 * edge} ${2 * edge}"><path fill="#fff" d="${d}"/></svg>\n`,
);

// The dev variant: the same document with a red background.
const devSource = path.join(tmp, "dev.icon");
fs.cpSync(source, devSource, { recursive: true });
const doc = JSON.parse(fs.readFileSync(path.join(devSource, "icon.json"), "utf8"));
doc.fill["linear-gradient"] = ["srgb:0.86000,0.20000,0.18000,1.00000", "srgb:0.52000,0.06000,0.06000,1.00000"];
fs.writeFileSync(path.join(devSource, "icon.json"), JSON.stringify(doc, null, 2) + "\n");

/** Renders one .icon document into outDir: Assets.car, icon.icns, icon.png (and icon.ico). */
function render(iconDoc, outDir, { ico = false } = {}) {
  const work = fs.mkdtempSync(path.join(tmp, "render-"));
  fs.mkdirSync(outDir, { recursive: true });

  // Assets.car. actool names the icon after the .icon file; CFBundleIconName is "Icon".
  fs.cpSync(iconDoc, path.join(work, "Icon.icon"), { recursive: true });
  fs.mkdirSync(path.join(work, "car"));
  run("xcrun", [
    "actool", path.join(work, "Icon.icon"), "--compile", path.join(work, "car"),
    "--output-partial-info-plist", path.join(work, "car/info.plist"),
    "--app-icon", "Icon", "--include-all-app-icons", "--enable-on-demand-resources", "NO",
    "--development-region", "en", "--target-device", "mac", "--minimum-deployment-target", "12.0", "--platform", "macosx",
  ]);
  fs.copyFileSync(path.join(work, "car/Assets.car"), path.join(outDir, "Assets.car"));

  // Flat renders. ictool draws the tile edge to edge; the macOS grid puts an
  // 824 px tile in 1024, so render smaller and pad with transparency.
  const png = (size) => {
    const out = path.join(work, `${size}.png`);
    if (fs.existsSync(out)) return out;
    const tile = Math.round((size * 824) / 1024);
    run(ictool, [iconDoc, "--export-image", "--output-file", out, "--platform", "macOS", "--rendition", "Default", "--width", String(tile), "--height", String(tile), "--scale", "1"]);
    run("sips", ["-p", String(size), String(size), out]);
    return out;
  };

  // macOS .icns from an .iconset (16…512 at 1x and 2x).
  const iconset = path.join(work, "icon.iconset");
  fs.mkdirSync(iconset);
  for (const s of [16, 32, 128, 256, 512]) {
    fs.copyFileSync(png(s), path.join(iconset, `icon_${s}x${s}.png`));
    fs.copyFileSync(png(s * 2), path.join(iconset, `icon_${s}x${s}@2x.png`));
  }
  execFileSync("iconutil", ["-c", "icns", iconset, "-o", path.join(outDir, "icon.icns")]);

  if (ico) {
    // Windows .ico: PNG-compressed entries, 16…256.
    const icoSizes = [16, 24, 32, 48, 64, 128, 256];
    const entries = icoSizes.map((s) => fs.readFileSync(png(s)));
    const header = Buffer.alloc(6 + 16 * entries.length);
    header.writeUInt16LE(1, 2);
    header.writeUInt16LE(entries.length, 4);
    let offset = header.length;
    entries.forEach((data, i) => {
      const s = icoSizes[i];
      const e = 6 + 16 * i;
      header.writeUInt8(s === 256 ? 0 : s, e);
      header.writeUInt8(s === 256 ? 0 : s, e + 1);
      header.writeUInt16LE(1, e + 4);
      header.writeUInt16LE(32, e + 6);
      header.writeUInt32LE(data.length, e + 8);
      header.writeUInt32LE(offset, e + 12);
      offset += data.length;
    });
    fs.writeFileSync(path.join(outDir, "icon.ico"), Buffer.concat([header, ...entries]));
  }

  fs.copyFileSync(png(1024), path.join(outDir, "icon.png"));
}

render(source, build, { ico: true });
render(devSource, path.join(build, "dev"), { ico: true });
fs.rmSync(tmp, { recursive: true, force: true });
console.log("wrote apps/desktop/build/{Assets.car,icon.icns,icon.png,icon.ico} and build/dev/ (the same, red)");
