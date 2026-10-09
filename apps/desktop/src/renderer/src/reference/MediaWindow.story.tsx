// Reference window, media (pnpm workbench mediawindow): one picture on a dark
// stage, a filmstrip of its siblings along the bottom edge, an inspector with
// what's known about it. The spec for Image, PDF, YouTube and any viewer.

import { Button, Filmstrip, Inline, KeyValue, MediaStage, Pane, Split, Stack, Text, ToolbarButton, ToolbarGroup, ToolbarMenu, ToolbarSpacer, ToolbarText, View, WindowToolbar } from "@cmd/ui";
import { useState } from "react";
import { AllSizes, photo, RefWindow, type SizeName } from "./RefWindow.tsx";

const PICS = Array.from({ length: 14 }, (_, i) => ({ key: `IMG_${4210 + i}.heic`, src: photo((i * 47) % 360, i % 5), label: `IMG_${4210 + i}.heic` }));

function Viewer({ size = "wide", empty }: { size?: SizeName; empty?: boolean }) {
  const [sel, setSel] = useState(PICS[3]!.key);
  const [info, setInfo] = useState(true);
  const i = PICS.findIndex((p) => p.key === sel);
  const pic = PICS[i]!;
  return (
    <RefWindow icon="photo" name={`${pic.label} · Photos`} size={size}>
      <View
        scroll={false}
        state={empty ? { kind: "empty", icon: "photo.on.rectangle", title: "No Pictures Here", text: "Drop images on this window, or open a folder that has some.", action: <Button>Open Folder…</Button> } : null}
        toolbar={
          <WindowToolbar label="Viewer">
            <ToolbarGroup>
              <ToolbarButton icon="chevron.left" label="Previous" shortcut="←" disabled={i === 0} onClick={() => setSel(PICS[i - 1]!.key)} />
              <ToolbarButton icon="chevron.right" label="Next" shortcut="→" disabled={i === PICS.length - 1} onClick={() => setSel(PICS[i + 1]!.key)} />
            </ToolbarGroup>
            <ToolbarText priority={1}>
              {i + 1} of {PICS.length}
            </ToolbarText>
            <ToolbarSpacer />
            <ToolbarMenu label="Zoom" onClick={() => {}} priority={2}>
              Fit
            </ToolbarMenu>
            <ToolbarButton icon="rotate.right" label="Rotate" shortcut="⌘R" secondary priority={1} />
            <ToolbarButton icon="square.and.arrow.up" label="Share" secondary priority={0} />
            <ToolbarButton icon="info.circle" label={info ? "Hide Info" : "Show Info"} shortcut="⌘I" pressed={info} onClick={() => setInfo((v) => !v)} priority={3} />
          </WindowToolbar>
        }
      >
        <Split
          side="end"
          open={info}
          width={{ min: 200, ideal: 230, max: 320 }}
          pane={
            <Stack gap="xl" pad="lg">
              <Stack gap="2xs">
                <Text strong truncate>
                  {pic.label}
                </Text>
                <Text tone="dim" size="sm">
                  Tuesday, 7 October 2026 at 18:42
                </Text>
              </Stack>
              <Pane title="Image">
                <KeyValue
                  items={[
                    ["Size", "4032 × 3024"],
                    ["File", "3.1 MB · HEIC"],
                    ["Colour", "Display P3"],
                  ]}
                />
              </Pane>
              <Pane title="Camera">
                <KeyValue
                  items={[
                    ["Device", "iPhone 17 Pro"],
                    ["Lens", "24 mm ƒ/1.78"],
                    ["Exposure", "1/120 s · ISO 80"],
                  ]}
                />
              </Pane>
              <Inline gap="sm" wrap>
                <Button icon="folder">Show in Files</Button>
              </Inline>
            </Stack>
          }
        >
          <MediaStage src={pic.src} alt={pic.label} />
          <Filmstrip items={PICS} selected={sel} onSelect={setSel} />
        </Split>
      </View>
    </RefWindow>
  );
}

export const Default = () => <Viewer />;
export const Sizes = () => <AllSizes render={(s) => <Viewer size={s} />} />;
export const Empty = () => <Viewer empty />;
