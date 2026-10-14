// Widget packages' windows (renderer half, docs/56): one view for every "pkg:<package>/<widget>"
// kind, which the core registers per package (core widgets/packages.ts); viewFor() falls back to it.

import { PackageView } from "./PackageView.tsx";
import { registerWindowView } from "../registry.ts";

registerWindowView({
  kind: "package",
  View: PackageView,
  describe: () => ({ kind: null }),
});
