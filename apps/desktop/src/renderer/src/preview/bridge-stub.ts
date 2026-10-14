// The preview page has no preload and no core (main.tsx): modules that subscribe to the core
// when they load (the package view's live trees) get a bridge that answers nothing. Imported
// first, so it is in place before they run. Own properties: lib/bridge.ts copies it.

const none = () => () => {};
(window as unknown as { cmd: unknown }).cmd ??= {
  call: () => Promise.reject(new Error("a preview has no core")),
  onEvent: none,
};
