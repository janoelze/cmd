// A layout per size: Adapt draws the first Case its own box fits, so one view has a compact, a
// regular and a large face (a player's, as Now Playing has); in a Pane it reads the pane's
// box, not the window's. Beside it the two props a face like that needs: Stack `justify`
// (the column centred in the room) and Text `fit` (a title as large as its column allows).
import type { ReactNode } from "react";
import { Adapt, Case } from "./adapt.tsx";
import { IconButton } from "./button.tsx";
import { Inline, Pane, Panes, Stack, Text, View } from "./frame.tsx";
import { Icon } from "./icon.tsx";

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
    <Case maxHeight={280}>
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
    <Case minWidth={340} minHeight={440}>
      <Stack pad="inset" gap={4} align="center" justify="center" grow>
        <Icon name="music.note" size={96} />
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
        <Icon name="music.note" size={64} />
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

/** One player at three sizes: short (240 tall), the fallback (320×360) and large (400×480): each its own face. */
export const Faces = () => (
  <Inline gap={4} align="start">
    <Box w={420} h={240}>
      <View scroll={false}>
        <Player />
      </View>
    </Box>
    <Box w={320} h={360}>
      <View scroll={false}>
        <Player />
      </View>
    </Box>
    <Box w={400} h={480}>
      <View scroll={false}>
        <Player />
      </View>
    </Box>
  </Inline>
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
  <Inline gap={4} align="start">
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
  </Inline>
);

/** Stack `justify` in a growing column: start, center, end, between. */
export const Justify = () => (
  <Inline gap={4} align="start">
    {(["start", "center", "end", "between"] as const).map((j) => (
      <Box key={j} w={160} h={200}>
        <Stack pad="inset" grow justify={j}>
          <Text strong>{j}</Text>
          <Text tone="dim">second</Text>
        </Stack>
      </Box>
    ))}
  </Inline>
);

/** Text `fit` in columns of three widths: one line, from its size up to the display size. */
export const Fit = () => (
  <Inline gap={4} align="start">
    {[200, 320, 520].map((w) => (
      <Box key={w} w={w} h={120}>
        <Stack pad="inset" grow justify="center">
          <Text strong fit size="lg">
            Windowlicker
          </Text>
        </Stack>
      </Box>
    ))}
  </Inline>
);
