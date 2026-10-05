// Workbench stories (pnpm workbench whatsnew): the What's New sheet.
import { RELEASES, WhatsNew } from "./WhatsNew.tsx";

const noop = () => {};

export const Latest = () => <WhatsNew releases={RELEASES.slice(0, 1)} onClose={noop} onLink={noop} />;
export const Several = () => <WhatsNew releases={RELEASES.slice(0, 4)} onClose={noop} onLink={noop} />;
export const Empty = () => <WhatsNew releases={[]} onClose={noop} onLink={noop} />;
