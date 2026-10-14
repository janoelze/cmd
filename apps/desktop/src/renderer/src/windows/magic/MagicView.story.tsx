// The Magic window's own states, at a regular size: asking (no provider, an error), a build
// (with steps, asking for permissions), a command to run, and "Download Deno?".

import type { MagicStep } from "@cmd/protocol";
import { View, WebStage } from "@cmd/ui";
import { useState } from "react";
import type { MagicLive } from "./magic.ts";
import { AllSizes, RefWindow, type SizeName } from "../../reference/RefWindow.tsx";
import { storyWindow } from "../../reference/RepoFile.tsx";
import { Ask, Building, runtimeRequest, TerminalOffer } from "./MagicView.tsx";

const step = (id: number, why: string, detail: string, ms?: number, isError?: boolean): MagicStep => ({ id, tool: "bash", why, detail, ms, isError, output: ms ? "Wi-Fi: connected\nVPN (WireGuard): connected" : undefined });
const LIVE: MagicLive = {
  running: true,
  steps: [step(1, "Looking at network services", "scutil --nc list", 820), step(2, "Reading the VPN's state", "scutil --nc status WireGuard", 410), step(3, "Writing the widget", "src/vpn.tsx")],
};

function W({ size = "regular", children }: { size?: SizeName; children: React.ReactNode }) {
  return (
    <RefWindow icon="sparkles" name="New Widget" size={size}>
      {children}
    </RefWindow>
  );
}

function AskStory({ needsAi = false, error }: { needsAi?: boolean; error?: string }) {
  const [text, setText] = useState("");
  return <Ask text={text} onText={setText} onAsk={() => {}} needsAi={needsAi} error={error} />;
}

export const Empty = () => (
  <W>
    <AskStory />
  </W>
);
export const NoProvider = () => (
  <W>
    <AskStory needsAi />
  </W>
);
export const AskError = () => (
  <W>
    <AskStory error="The request timed out. Try again, or ask for something smaller." />
  </W>
);
export const Building_ = () => (
  <W>
    <View scroll={false}>
      <Building live={LIVE} showSteps={false} onStop={() => {}} />
    </View>
  </W>
);
export const BuildingWithSteps = () => (
  <W>
    <View scroll={false}>
      <Building live={LIVE} showSteps onStop={() => {}} />
    </View>
  </W>
);
export const Command = () => (
  <W>
    <View scroll={false}>
      <TerminalOffer win={storyWindow("magic", {})} command="networksetup -getairportnetwork en0" />
    </View>
  </W>
);
/** A package asking for what it wants: Allow… brings the grants sheet back. */
export const AskingForPermissions = () => (
  <W>
    <View scroll={false}>
      <Building live={{ ...LIVE, steps: [...LIVE.steps, { id: 4, tool: "permissions", why: "Wants to reach api.github.com", detail: "ci-runs" }] }} showSteps={false} onStop={() => {}} onAllow={() => {}} />
    </View>
  </W>
);
/** The first build on a Mac without Deno. */
export const DenoRequest = () => (
  <W>
    <View scroll={false}>
      <WebStage cover={runtimeRequest(() => {})}>
        <div />
      </WebStage>
    </View>
  </W>
);
export const Sizes = () => <AllSizes render={(s) => <W size={s}><AskStory /></W>} />;
