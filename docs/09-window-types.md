# Window types

Everything the main pane shows is a **window**: a terminal, a browser, a file tree, a text editor, and whatever comes next. Each kind is a **window type** with two halves:

- **Core half** (`packages/core/src/windows/`): what it is, what it can open, and how its state is created and updated. The core stores each window's `state` as opaque JSON and syncs it to every UI, so a new type needs no protocol or storage changes.
- **UI half** (`apps/desktop/src/renderer/src/windows/`): the view, title-bar meta, sidebar labels and menu entries.

The built-in types register through exactly the same API a plugin will use.

## Adding a type: a Markdown preview example

### 1. Core: `packages/core/src/windows/builtin.ts` (later: a plugin's `core.ts`)

```ts
export const markdownPreviewType: WindowType<{ path: string }> = {
  kind: "markdown-preview",
  title: "Markdown Preview",
  icon: "doc.richtext",                       // SF Symbol
  opens: { extensions: ["md"], priority: 10 }, // beats "text" for .md
  fromTarget: (t) => ({ path: t.type === "path" ? t.path : "" }),
  create: (input) => ({ state: { path: String(input.path) }, title: path.basename(String(input.path)) }),
  update: (state, patch) => ({ state: { ...state, ...patch } }), // optional
};
// registerBuiltins(): types.register(markdownPreviewType)
```

### 2. UI: `apps/desktop/src/renderer/src/windows/builtin.tsx`

```tsx
registerWindowView({
  kind: "markdown-preview",
  View: ({ win, focused }) => <MarkdownPreview path={stateStr(win, "path")!} focused={focused} />,
  detail: (w) => shortPath(stateStr(w, "path") ?? ""),
  meta: (w) => <span className="tile-path">{shortPath(stateStr(w, "path") ?? "")}</span>,
  menu: (w) => [{ label: "Open as Text", run: () => cmd.call("window.open", { kind: "text", input: { path: stateStr(w, "path") } }) }],
});
```

### What you get without touching anything else

- **All layouts:** focus, grid and strip, including drag/push, resize, dimming, title bar and sidebar row (with the icon).
- **Persistence:** the window survives core and app restarts.
- **Routing:** `open notes.md` in a terminal, double-click in the file tree, palette paths and `cmd open notes.md` all route `.md` to the new type. The zsh rules come from the registry (`CMD_OPEN_EXTS` and friends), so the shell can't drift.
- **Programmatic opening:** `cmd open --kind markdown-preview file.md`, `window.open` over RPC, and host agents through the same API.
- **Live files:** views can use `fs.watch`/`fs.changed`, `fs.read`/`fs.write`, and `setWindowStatus` for title-bar status.

## Routing rules

`WindowTypes.resolve(target)` picks a type in this order:

1. **The `open.handlers` setting:** e.g. `"md: browser, log: text"`. Extension-level overrides, user's choice first.
2. **Specificity:** URL scheme or extension match (3) > folder (2) > "looks like text" (1).
3. **`priority`:** breaks ties between types that match equally specifically.

If nothing matches, the target goes to the default macOS app.

## Towards plugins

A plugin will be a folder with a manifest (`contributes.windowTypes`) plus the same two halves, loaded by the plugin host (docs/06). Open questions to settle then:

- **Loading third-party UI code safely:** a trusted ES module, or an isolated webview with a message bridge.
- **Menu bar commands contributed at runtime:** the main process builds the menu from a static list today.
- **Terminal windows** are still special-cased in places, because they're backed by panes and agents. They would move onto the view registry as `kind: "terminal"` last.
