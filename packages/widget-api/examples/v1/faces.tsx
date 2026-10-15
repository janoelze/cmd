// The example of API 1.3's layout by size (docs/57, A1–A3): a player with three faces in an
// `Adapt`, one per size of the reference windows: compact under 360 px wide (a line and
// the controls), large from 600×440 (a centred column, the title as large as it fits), and
// the regular one as the fallback. cmd switches them as the window resizes, without this
// process; `useSize()` is only logic: the title bar's status shows from 360 px wide. Its
// story (renderer windows/package/faces.story.tsx) draws it at the three reference sizes.

import { Adapt, Case, IconButton, Inline, Stack, Text, View, Window, useSize } from "@cmd/widget-api";

const TRACK = { title: "Windowlicker", artist: "Aphex Twin", left: "3:12 left" };

function Controls({ wide = false }: { wide?: boolean }) {
  return (
    <Inline gap={wide ? 6 : 2} justify={wide ? undefined : "start"}>
      <IconButton icon="backward.fill" label="Previous" />
      <IconButton icon="pause.fill" label="Pause" size="lg" />
      <IconButton icon="forward.fill" label="Next" />
    </Inline>
  );
}

export default function Faces() {
  const box = useSize();
  return (
    <Window status={box && box.width >= 360 ? `Playing · ${TRACK.left}` : null}>
      <View scroll={false}>
        <Adapt>
          <Case maxWidth={359}>
            <Stack pad="inset" gap={3} grow justify="between">
              <Stack gap={0.5}>
                <Text strong truncate>
                  {TRACK.title}
                </Text>
                <Text tone="dim" truncate>
                  {TRACK.artist}
                </Text>
              </Stack>
              <Controls />
            </Stack>
          </Case>
          <Case minWidth={600} minHeight={440}>
            <Stack pad="inset" gap={4} grow align="center" justify="center">
              <Stack gap={1} align="center">
                <Text strong fit size="lg">
                  {TRACK.title}
                </Text>
                <Text tone="dim">{TRACK.artist}</Text>
              </Stack>
              <Controls wide />
            </Stack>
          </Case>
          <Case>
            <Stack pad="inset" gap={3} grow justify="end">
              <Stack gap={0.5}>
                <Text strong size="xl">
                  {TRACK.title}
                </Text>
                <Text tone="dim">{TRACK.artist}</Text>
              </Stack>
              <Controls />
            </Stack>
          </Case>
        </Adapt>
      </View>
    </Window>
  );
}
