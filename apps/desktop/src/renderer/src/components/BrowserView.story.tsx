// Workbench stories (pnpm workbench browserview): the Browser window, blank (New Tab),
// a page that didn't load (a closed port), and a phone's size; every size.

import { AllSizes, RefWindow, type SizeName } from "../reference/RefWindow.tsx";
import { storyWindow } from "../reference/RepoFile.tsx";
import { BrowserView } from "./BrowserView.tsx";

function W({ url, device, size = "regular" }: { url?: string; device?: string; size?: SizeName }) {
  return (
    <RefWindow icon="globe" name="Browser" size={size}>
      <BrowserView key={`${url}-${device}`} win={storyWindow("browser", { url, device })} focused={false} />
    </RefWindow>
  );
}

export const Blank = () => <W />;
export const Failed = () => <W url="http://localhost:1" />;
export const Device = () => <W url={`data:text/html,<h1 style="font-family:system-ui">Hello from a phone</h1>`} device="iphone-16" size="wide" />;
export const Sizes = () => <AllSizes render={(s) => <W size={s} />} />;
