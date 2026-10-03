// node-pty 1.1.0 ships its macOS spawn-helper prebuild without the exec bit,
// which makes every pty.spawn fail with "posix_spawnp failed".
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { execFileSync } from "node:child_process";

const require = createRequire(path.resolve("packages/core/package.json"));
try {
  const root = path.dirname(require.resolve("node-pty/package.json"));
  for (const arch of ["darwin-arm64", "darwin-x64"]) {
    const helper = path.join(root, "prebuilds", arch, "spawn-helper");
    if (fs.existsSync(helper)) fs.chmodSync(helper, 0o755);
  }
} catch (err) {
  console.warn("postinstall: could not fix node-pty spawn-helper:", err.message);
}

// Build the core's native foreground-process helper (see packages/core/native/procinfo.c).
// execFile, not a shell, so shell aliases (e.g. a `cc` alias) don't interfere.
try {
  const dir = path.resolve("packages/core/native");
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  execFileSync("/usr/bin/clang", ["-O2", "-Wall", "-o", path.join(dir, "build/procinfo"), path.join(dir, "procinfo.c")], { stdio: "inherit" });
} catch (err) {
  console.warn("postinstall: could not build procinfo (agent detection falls back to process names):", err.message);
}

// Build the desktop app's native SF Symbols renderer (crisp icons at exact sizes).
try {
  const dir = path.resolve("apps/desktop/native");
  fs.mkdirSync(path.join(dir, "build"), { recursive: true });
  execFileSync("/usr/bin/xcrun", ["swiftc", "-O", "-o", path.join(dir, "build/sfsymbols"), path.join(dir, "sfsymbols.swift")], { stdio: "inherit" });
} catch (err) {
  console.warn("postinstall: could not build sfsymbols (icons fall back to resized bitmaps):", err.message);
}

// pnpm sometimes skips electron's own postinstall (build-script approval);
// fetch the binary if it is missing.
try {
  const req = createRequire(path.resolve("apps/desktop/package.json"));
  const dir = path.dirname(req.resolve("electron/package.json"));
  if (!fs.existsSync(path.join(dir, "path.txt"))) {
    execFileSync(process.execPath, [path.join(dir, "install.js")], { stdio: "inherit" });
  }
} catch (err) {
  console.warn("postinstall: could not install electron binary:", err.message);
}

// Dev runs use the stock Electron.app, and macOS titles the app menu (and ⌘-Tab,
// with the icon) from the bundle, not from app.name: brand it as cmd. Its ad-hoc
// signature doesn't seal Info.plist or resources, so no re-signing is needed.
if (process.platform === "darwin") {
  try {
    const req = createRequire(path.resolve("apps/desktop/package.json"));
    const bundle = path.join(path.dirname(req.resolve("electron/package.json")), "dist/Electron.app");
    const plist = path.join(bundle, "Contents/Info.plist");
    for (const key of ["CFBundleName", "CFBundleDisplayName"]) execFileSync("/usr/bin/plutil", ["-replace", key, "-string", "cmd", plist]);
    fs.copyFileSync(path.resolve("apps/desktop/build/icon.icns"), path.join(bundle, "Contents/Resources/electron.icns"));
    fs.copyFileSync(path.resolve("apps/desktop/build/Assets.car"), path.join(bundle, "Contents/Resources/Assets.car"));
    execFileSync("/usr/bin/plutil", ["-replace", "CFBundleIconName", "-string", "Icon", plist]);
    const now = new Date();
    fs.utimesSync(bundle, now, now); // so LaunchServices picks up the new name and icon
  } catch (err) {
    console.warn("postinstall: could not brand the dev Electron.app:", err.message);
  }
}
