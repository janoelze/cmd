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
