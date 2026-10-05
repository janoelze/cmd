// The Workbench: a toolbar (story, variant, theme) over a stage that renders one
// variant. Stories are *.story.tsx files anywhere in the renderer; each named
// export is a variant (a component without props). The URL holds the choice
// (?story=feedback&variant=Sent&theme=gruvbox-dark), so a script can drive it.

import { useEffect, useState, type ComponentType } from "react";
import { Segmented, Select, Spacer, Toolbar } from "@cmd/ui";
import { allThemes, applyTheme, themeFor } from "@cmd/ui/themes";
import type { SettingsSnapshot } from "@cmd/protocol";
import { cmd } from "../bridge.ts";
import { applyThemeSettings } from "../theme.ts";
import { applyLookSettings } from "../look.ts";

type Variants = Record<string, ComponentType>;
const files = import.meta.glob<Variants>("../**/*.story.tsx");
/** "components/Feedback.story.tsx" → "feedback". */
const STORIES = Object.keys(files)
  .map((path) => ({ id: path.split("/").pop()!.replace(".story.tsx", "").toLowerCase(), path }))
  .sort((a, b) => a.id.localeCompare(b.id));

const FOLLOW = "settings";

function useParam(name: string, fallback: string): [string, (v: string) => void] {
  const [value, setValue] = useState(() => new URLSearchParams(location.search).get(name) ?? fallback);
  const set = (v: string) => {
    const q = new URLSearchParams(location.search);
    q.set(name, v);
    history.replaceState(null, "", `?${q}`);
    setValue(v);
  };
  // A script changes the URL with history.replaceState and fires this to apply it.
  useEffect(() => {
    const on = () => setValue(new URLSearchParams(location.search).get(name) ?? fallback);
    addEventListener("workbench:url", on);
    return () => removeEventListener("workbench:url", on);
  }, [name, fallback]);
  return [value, set];
}

/** The theme: the app's settings (live), or one picked here (this window only). Subscribes to every
 * event, like the app window: a subscription replaces the last one, and stories need ai.updated etc. */
function useWorkbenchTheme(theme: string) {
  const [settings, setSettings] = useState<SettingsSnapshot["settings"] | null>(null);
  useEffect(() => {
    const off = cmd.onEvent((e) => e.type === "settings.updated" && setSettings(e.snapshot.settings));
    cmd.onStatus((s) => s === "connected" && void cmd.call("events.subscribe", {}).then((r) => setSettings(r.settings.settings)));
    return off;
  }, []);
  useEffect(() => {
    const t = theme !== FOLLOW ? themeFor(theme) : undefined;
    if (t) {
      applyTheme(t);
      cmd.setAppearance({ source: t.appearance, background: t.colors.bg, dockIcon: null });
    } else if (settings) applyThemeSettings(settings);
    if (settings) applyLookSettings(settings);
    // Read by scripts/workbench.mjs: a shot waits until the theme it asked for is on.
    document.body.dataset.theme = t ? t.id : FOLLOW;
  }, [theme, settings]);
}

export function Workbench() {
  const [storyId, setStory] = useParam("story", STORIES[0]?.id ?? "");
  const [variant, setVariant] = useParam("variant", "");
  const [theme, setTheme] = useParam("theme", FOLLOW);
  // Bumped by scripts to remount the variant fresh (whatever was clicked in it).
  const [mount] = useParam("mount", "0");
  const [variants, setVariants] = useState<Variants | null>(null);
  useWorkbenchTheme(theme);

  const story = STORIES.find((s) => s.id === storyId);
  useEffect(() => {
    setVariants(null);
    if (story) void files[story.path]!().then(setVariants);
  }, [story?.path]); // eslint-disable-line react-hooks/exhaustive-deps

  const names = variants ? Object.keys(variants).filter((k) => typeof variants[k] === "function") : [];
  const name = names.includes(variant) ? variant : names[0];
  const View = name ? variants![name] : null;
  // Read by scripts/workbench.mjs: what is on stage, once it rendered.
  useEffect(() => {
    document.body.dataset.ready = View ? `${storyId}/${name}` : "";
    document.body.dataset.variants = names.join(",");
  }, [View, storyId, name, names.join()]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div className="wb">
      <Toolbar edge="bottom" className="wb-bar" label="Workbench">
        <Select label="Story" value={storyId} options={STORIES.map((s) => s.id)} onChange={setStory} placeholder="No stories" />
        {names.length > 1 && (names.length <= 5 ? <Segmented label="Variant" value={name!} options={names} onChange={setVariant} /> : <Select label="Variant" value={name!} options={names} onChange={setVariant} />)}
        <Spacer />
        <Select label="Theme" value={theme} options={[{ value: FOLLOW, label: "Theme from Settings" }, ...allThemes().map((t) => ({ value: t.id, label: t.title }))]} onChange={setTheme} />
      </Toolbar>
      {/* key: a new variant (or mount) starts with fresh state. */}
      <main className="wb-stage">{View && <View key={`${storyId}/${name}/${mount}`} />}</main>
    </div>
  );
}
