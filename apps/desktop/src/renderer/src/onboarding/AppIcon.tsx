// The app's icon in the theme's colours: the same images the themed Dock icon
// uses (build/themes, theme.dockIcon), falling back to the default one.

import { useTheme } from "@cmd/ui/themes";

const ICONS = import.meta.glob<string>("../../../../build/themes/*.png", { eager: true, query: "?url", import: "default" });
const iconFor = (id: string) => ICONS[`../../../../build/themes/${id}.png`] ?? ICONS["../../../../build/themes/default.png"];

export function AppIcon({ size = 96 }: { size?: number }) {
  const theme = useTheme();
  // The image has a transparent margin (1/14 of its size): pull it back so the tile lines up with text.
  return <img src={iconFor(theme.id)} width={size} height={size} alt="" draggable={false} style={{ display: "block", margin: -size / 14 }} />;
}
