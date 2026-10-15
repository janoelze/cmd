// A package using Adapt (API 1.3, docs/57 A1–A3): the example player
// (packages/widget-api/examples/v1/faces.tsx) running in the widget runtime against the fake
// host, drawn by the package view as a package's story is (workbench/widgetStory.tsx). Sizes
// runs it once per reference window, each with that window's env (its size class and box),
// and the package view's Adapt picks each window's face from its own measured box.

import Player from "@cmd/widget-api/examples/v1/faces.tsx";
import { widgetStory } from "../../workbench/widgetStory.tsx";

const stories = widgetStory({ default: Player, Playing: {} }, { name: "faces", version: "1.0.0", cmd: { widgets: [{ id: "faces", title: "Player", icon: "music.note", main: "src/faces.tsx" }] } }, "faces");

/** The player in a regular window: the fallback face, the status in the title bar. */
export const Playing = stories.Playing!;

/** Narrow (compact: a line and the controls, no status), regular (the fallback) and wide (a centred column, its title fit to it). */
export const Sizes = stories.Sizes!;
