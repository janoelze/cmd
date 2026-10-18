// Electron main's entry: loads the app (app.ts) and nothing before it, so a version whose
// app can't load still finds and installs its fix (rescue in updater.ts) rather than
// stopping at Electron's error dialog with no way out (0.32.0: a package missing from
// app.asar). Top-level await: Electron holds `ready` until the entry has run, which
// app.ts needs (privileged schemes are registered before ready). So the rescue, which
// waits for ready, isn't awaited.

try {
  await import("./app.ts");
} catch (err) {
  void import("./updater.ts").then((u) => u.rescue(err));
}
