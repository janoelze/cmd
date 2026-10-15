// Picture in a box (a cover, a thumbnail, a logo): each fit, each ratio, each size, the
// placeholder at each size (no picture, or one that failed), and "fill" taking the room above
// a player. The Image window's bare Picture is frame.story.tsx's Pictures.
import type { ReactNode } from "react";
import { Inline, Stack, Text } from "./frame.tsx";
import { Picture } from "./picture.tsx";
import { picture } from "./fixtures.ts";

const WIDE = picture(210, "", 640, 360);
const TALL = picture(30, "", 300, 450);
const SQUARE = picture(280, "", 400, 400);

const Labelled = ({ label, children }: { label: string; children: ReactNode }) => (
  <Stack gap={1} align="center">
    {children}
    <Text tone="dim" size="sm">
      {label}
    </Text>
  </Stack>
);

/** cover (the default) crops a picture to its box; contain fits it inside, the box's colour around it. */
export const Fits = () => (
  <Inline gap={6} align="start">
    <Labelled label="cover, wide">
      <Picture src={WIDE} alt="A wide picture" size={128} />
    </Labelled>
    <Labelled label="contain, wide">
      <Picture src={WIDE} alt="A wide picture" size={128} fit="contain" />
    </Labelled>
    <Labelled label="cover, tall">
      <Picture src={TALL} alt="A tall picture" size={128} />
    </Labelled>
    <Labelled label="contain, tall">
      <Picture src={TALL} alt="A tall picture" size={128} fit="contain" />
    </Labelled>
  </Inline>
);

/** Width over height: square (1), 4:3, 3:2 and 16:9. */
export const Ratios = () => (
  <Inline gap={6} align="end">
    {[1, 1.333, 1.5, 1.778].map((r) => (
      <Labelled key={r} label={String(r)}>
        <Picture src={WIDE} alt="A landscape" size={128} ratio={r} />
      </Labelled>
    ))}
  </Inline>
);

/** The widths a widget picks from, and the corners: md (default), sm, none. */
export const Sizes = () => (
  <Stack gap={4}>
    <Inline gap={4} align="end">
      {[24, 32, 44, 64, 96, 128].map((s) => (
        <Labelled key={s} label={`${s}`}>
          <Picture src={SQUARE} alt="A cover" size={s} radius={s < 44 ? "sm" : "md"} />
        </Labelled>
      ))}
    </Inline>
    <Inline gap={4} align="end">
      {(["md", "sm", "none"] as const).map((r) => (
        <Labelled key={r} label={r}>
          <Picture src={SQUARE} alt="A cover" size={96} radius={r} />
        </Labelled>
      ))}
    </Inline>
  </Stack>
);

/** No picture yet, none at all, or one that failed: the box in the chart track colour, its icon sized to it. */
export const Placeholder = () => (
  <Stack gap={4}>
    <Inline gap={4} align="end">
      {[24, 32, 44, 64, 96, 128].map((s) => (
        <Labelled key={s} label={`${s}`}>
          <Picture src={null} alt="No cover" icon="music.note" size={s} radius={s < 44 ? "sm" : "md"} />
        </Labelled>
      ))}
    </Inline>
    <Inline gap={4} align="end">
      <Labelled label="no icon">
        <Picture src={null} alt="Nothing" size={64} />
      </Labelled>
      <Labelled label="failed">
        <Picture src="data:image/png;base64,AAAA" alt="A broken picture" icon="photo" size={64} />
      </Labelled>
      <Labelled label="16:9">
        <Picture src={null} alt="No thumbnail" icon="play.rectangle" size={128} ratio={1.778} />
      </Labelled>
    </Inline>
  </Stack>
);

/** "fill": as large as the room above a player allows, square, centred; the placeholder too. */
export const Fill = () => (
  <Inline gap={4} align="start">
    {[SQUARE, null].map((src, i) => (
      <div key={i} style={{ width: 280, height: 320, display: "flex", flexDirection: "column", gap: "var(--space-3)", padding: "var(--space-4)", boxSizing: "border-box", background: "var(--well)", borderRadius: "var(--radius-md)", boxShadow: "inset 0 0 0 1px var(--separator)" }}>
        <Picture src={src} alt="A cover" icon="music.note" size="fill" />
        <Text strong size="lg">Interdimensional Life</Text>
        <Text tone="dim">ooxygen</Text>
      </div>
    ))}
  </Inline>
);
