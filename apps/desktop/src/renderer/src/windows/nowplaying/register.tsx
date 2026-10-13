// Now Playing widgets (renderer half): the core reads what's playing (core nowplaying/).

import { NowPlayingView } from "./NowPlayingView.tsx";
import { registerWindowView } from "../registry.ts";

registerWindowView({
  kind: "nowplaying",
  View: NowPlayingView,
  describe: () => ({ kind: null }),
});
