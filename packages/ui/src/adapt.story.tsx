// A layout per size: Adapt draws the first Case its own box fits, so one view has a compact, a
// regular and a large face (a player's, as Now Playing has); in a Pane it reads the pane's
// box, not the window's. Beside it the two props a face like that needs: Stack `justify`
// (the column centred in the room) and Text `fit` (a title as large as its column allows).
import type { ReactNode } from "react";
import { Adapt, Case } from "./adapt.tsx";
import { IconButton } from "./button.tsx";
import { Inline, Pane, Panes, Stack, Text, View } from "./frame.tsx";
import { Icon } from "./icon.tsx";

/** The boxes side by side, wrapping in a stage that is narrower. */
const Row = ({ children }: { children: ReactNode }) => <div style={{ display: "flex", flexWrap: "wrap", alignItems: "flex-start", gap: "var(--space-4)", maxWidth: 880 }}>{children}</div>;

/** A window's body at a size, with its size written under it. */
const Box = ({ w, h, children }: { w: number; h: number; children: ReactNode }) => (
  <Stack gap={1}>
    <div style={{ width: w, height: h, display: "flex", flexDirection: "column", borderRadius: "var(--radius-md)", overflow: "hidden", background: "var(--well)", boxShadow: "inset 0 0 0 1px var(--separator)" }}>{children}</div>
    <Text tone="dim" size="sm">
      {w}×{h}
    </Text>
  </Stack>
);

const Controls = ({ gap = 2 }: { gap?: 2 | 6 }) => (
  <Inline gap={gap}>
    <IconButton icon="backward.fill" label="Previous" />
    <IconButton icon="pause.fill" label="Pause" size="lg" />
    <IconButton icon="forward.fill" label="Next" />
  </Inline>
);

/** The three faces of a player: short (a line and the controls), large (a centred column, the title as large as it fits) and the fallback. */
const Player = () => (
  <Adapt>
    <Case maxHeight={240}>
      <Stack pad="inset" gap={3} justify="between" grow>
        <Inline gap={3}>
          <Icon name="music.note" size={28} />
          <Stack gap={0.5}>
            <Text strong truncate>
              Windowlicker
            </Text>
            <Text tone="dim" truncate>
              Aphex Twin
            </Text>
          </Stack>
        </Inline>
        <Controls />
      </Stack>
    </Case>
    <Case minWidth={280} minHeight={360}>
      <Stack pad="inset" gap={4} align="center" justify="center" grow>
        <Icon name="music.note" size={64} />
        <Stack gap={1} align="center">
          <Text strong fit size="lg">
            Windowlicker
          </Text>
          <Text tone="dim">Aphex Twin</Text>
        </Stack>
        <Controls gap={6} />
      </Stack>
    </Case>
    <Case>
      <Stack pad="inset" gap={3} grow justify="end">
        <Icon name="music.note" size={44} />
        <Stack gap={0.5}>
          <Text strong size="lg" truncate>
            Windowlicker
          </Text>
          <Text tone="dim">Aphex Twin</Text>
        </Stack>
        <Controls />
      </Stack>
    </Case>
  </Adapt>
);

/** One player at three sizes: short (up to 240 tall), large (from 280×360) and the fallback between: each its own face. (Now Playing breaks at 280 and 340×440; these are smaller to fit a stage.) */
export const Faces = () => (
  <Row>
    <Box w={280} h={200}>
      <View scroll={false}>
        <Player />
      </View>
    </Box>
    <Box w={240} h={320}>
      <View scroll={false}>
        <Player />
      </View>
    </Box>
    <Box w={300} h={380}>
      <View scroll={false}>
        <Player />
      </View>
    </Box>
  </Row>
);

/** In Panes, each Adapt reads its pane's width, not the window's: the same window, a list face in a narrow pane and a row in a wide one. */
const Counts = () => (
  <Adapt>
    <Case minWidth={360}>
      <Inline gap={6}>
        <Text size="xl">12 runs</Text>
        <Text size="xl">3 failed</Text>
      </Inline>
    </Case>
    <Case>
      <Stack gap={1}>
        <Text>12 runs</Text>
        <Text tone="danger">3 failed</Text>
      </Stack>
    </Case>
  </Adapt>
);
export const InPanes = () => (
  <Row>
    <Box w={480} h={260}>
      <View inset>
        <Panes>
          <Pane title="Today">
            <Counts />
          </Pane>
        </Panes>
      </View>
    </Box>
    <Box w={760} h={260}>
      <View inset>
        <Panes>
          <Pane title="Today">
            <Counts />
          </Pane>
          <Pane title="This week">
            <Counts />
          </Pane>
        </Panes>
      </View>
    </Box>
  </Row>
);

/** Stack `justify` in a growing column: start, center, end, between. */
export const Justify = () => (
  <Row>
    {(["start", "center", "end", "between"] as const).map((j) => (
      <Box key={j} w={160} h={200}>
        <Stack pad="inset" grow justify={j}>
          <Text strong>{j}</Text>
          <Text tone="dim">second</Text>
        </Stack>
      </Box>
    ))}
  </Row>
);

/** Text `fit` in columns of three widths: one line, from its size (md here) up to the display size. */
export const Fit = () => (
  <Row>
    {[120, 160, 240].map((w) => (
      <Box key={w} w={w} h={96}>
        <Stack pad="inset" grow justify="center">
          <Text strong fit>
            Windowlicker
          </Text>
        </Stack>
      </Box>
    ))}
  </Row>
);
