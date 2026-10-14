// A widget package's window (docs/56), a placeholder: the window type exists so a package
// widget can be put on the board; the view that draws its tree replaces this (phase 1, item D).

import { View } from "@cmd/ui";
import type { WindowViewProps } from "../registry.ts";

export function PackageView({ win }: WindowViewProps) {
  const name = typeof win.state.package === "string" ? win.state.package : "this package";
  return <View state={{ kind: "empty", icon: "puzzlepiece.extension", title: win.title, text: `${name} is installed. Its view isn't drawn yet.` }} />;
}
