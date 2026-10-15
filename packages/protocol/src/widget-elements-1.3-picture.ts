// API 1.3's Picture (docs/57, "1.3 additions" A5): an image from the widget's data or from a
// host its package is granted. The page never loads one: the renderer takes only a `data:`
// image (PICTURE_DATA below), and for an https `src` the core fetches it as `net.fetch` does
// (core widgets/api/picture.ts: the grant per URL, the magic bytes, the size, a cache) and puts
// a `data:` URL in the tree the renderer gets. No SVG ever: it can carry script and references.
// widget-elements.ts merges these into API_ELEMENTS.

import { SYMBOL, press, type ApiElementSpec } from "./widget-spec.ts";

const since = "1.3";

export const ELEMENTS_1_3_PICTURE = {
  Picture: {
    doc: "An image: a cover, a thumbnail, a logo. From a data: URL, or an https URL of a host in the package's net grant, which cmd fetches; never loaded by the page.",
    since,
    props: {
      src: { type: "string", nullable: true, doc: "data:image/png|jpeg|webp|gif;base64,… (at most 512 KB), or https://<a granted host>/… (cmd fetches it: at most 2 MB and 4096 px a side, kept an hour); null shows the placeholder. Never SVG." },
      alt: { type: "string", required: true, shows: "title", doc: "What it shows, in words (its accessible name; what stands in on a paired device that draws none)." },
      fit: { type: ["cover", "contain"], doc: "Fills its box, cropped (default), or fits inside it." },
      ratio: { type: [1, 1.333, 1.5, 1.778], doc: "Width over height (default 1: square)." },
      size: { type: [24, 32, 44, 64, 96, 128, "fill"], doc: 'Its width in px (default 64), or "fill": as large as the room left allows (a cover above a player).' },
      radius: { type: ["sm", "md", "none"], doc: "Its corners (default md)." },
      icon: { type: "string", doc: `${SYMBOL} On the placeholder box (no src, loading, or failed), in the chart track colour.` },
    },
    events: { onClick: press("Pressed.") },
    children: "none",
  },
} as const satisfies Record<string, ApiElementSpec>;

/** The images a Picture's `data:` src may be: never SVG. */
export const PICTURE_TYPES = ["png", "jpeg", "webp", "gif"] as const;
/** The most a Picture's `data:` src may be (characters of the URL). */
export const PICTURE_DATA_MAX = 512 * 1024;
/** The most pictures one tree holds (characters of their `data:` URLs, the fetched ones included): one past it shows its placeholder. */
export const PICTURE_TREE_MAX = 4 * 1024 * 1024;
/** A `data:` src the renderer draws: base64 of one of PICTURE_TYPES. The core checks the bytes are what it says. */
export const PICTURE_DATA = /^data:image\/(png|jpeg|webp|gif);base64,[A-Za-z0-9+/]+={0,2}$/;
/** Whether a string is a Picture `data:` src the renderer may draw (the type, and no longer than a whole tree's pictures; the core checks the bytes and each one's size). */
export const isPictureData = (s: unknown): s is string => typeof s === "string" && s.length <= PICTURE_TREE_MAX && PICTURE_DATA.test(s);
