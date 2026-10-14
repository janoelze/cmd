// The preview page has no preload and no core (main.tsx): modules that subscribe to the core
// when they load (the package view's live trees) get a bridge that answers nothing. Imported
// first, so it is in place before they run. Own properties: lib/bridge.ts copies it.

const none = () => () => {};
(window as unknown as { cmd: unknown }).cmd ??= {
  call: () => Promise.reject(new Error("a preview has no core")),
  onEvent: none,
  // What the package view's imports (lib/store.ts and what it loads) ask for as they load:
  // never answered, so the defaults stay. A module that calls something else on load breaks
  // the page (`cmd widget preview` and Magic's previews say so).
  keybindings: () => new Promise(() => {}),
  onKeybindings: none,
  appInfo: () => new Promise(() => {}),
  onShowWorkspace: none,
  onStatus: none,
};
