# Browser inspector

**Status:** research (2026-10-17): the routes to Chromium's DevTools for browser windows, each tried in a spike against Electron 44.5.1; a recommendation and a plan.

From a user's feedback (0.30.0): *"Longing for Inspector when using the browser. Could inspector live inside a window? Would be nice to keep the browser size and have the inspector next to it. Cmd's panel view is like a virtual ultra wide screen that would allow me to keep the inspector next to the browser window."*

The ask is two things: DevTools at all (browser windows have none today), and DevTools as **its own window on the board**, beside the page, so the page keeps its size. Docking DevTools inside the browser window, as Chrome does, would squeeze the page, and the board already gives the room.

Read first: `apps/desktop/src/renderer/src/windows/browser/BrowserView.tsx` (the window), `apps/desktop/src/main/web-session.ts` and `web-policy.ts` (what guests may do), docs/09-window-types.md.

## What exists

- A browser window is an Electron `<webview>` in the `persist:cmd-browser` session, not a native `WebContentsView`, on purpose: a webview is composited into the app's page, so it moves with the board's transforms (`TileMotion`) and sheets, the palette and popovers draw over it. A native view always sits on top and doesn't follow CSS.
- Moving a window's DOM (docking it into a sidebar, `shell/board/Dock.tsx`) makes Electron re-attach the webview: **a new guest `WebContents`** (new id; the old one is destroyed) that reloads the page. Anything bound to a guest by id has to follow it.
- `will-attach-webview` (`web-session.ts`) refuses any guest outside `persist:cmd-browser`, gives every guest the guest preload (`preload/guest.ts`, which reports presses so the window gets selected), no Node, sandbox on.
- A right-click in a page shows nothing: the guest preload only reports left presses (Magic widgets forward theirs to the window's menu, `lib/embed.ts`).
- The `@developer` menu's Toggle Developer Tools opens the **app's** DevTools, not a page's.
- Agents read and drive pages through the renderer (`browser.read`, `browser.act`: `executeJavaScript` in the webview). Nothing reads a page's console or network yet.

## What the spike found

Throwaway Electron 44.5.1 apps (one window, a page webview, a second surface for DevTools):

| Try | Result |
|---|---|
| `guest.openDevTools({ mode: "detach" })` (Electron's own DevTools window) | Works: full DevTools for the page, in a separate macOS window. |
| `setDevToolsWebContents(<webview>)` + `openDevTools()` (the example in Electron's docs) | **Doesn't work.** The front end loads (`devtools://devtools/bundled/devtools_app.html`) but never connects: empty Elements, no `devtools-opened`. Same with any partition, `about:blank` or not, page in a webview or in a view. |
| `setDevToolsWebContents(WebContentsView)` | Works, for a webview guest too: DOM, styles, console. (`isDevToolsOpened()` says false with a custom host; ignore it.) |
| The bundled front end loaded **in a `<webview>`** with `?ws=127.0.0.1:<port>/<token>`, main relaying that WebSocket to `guest.debugger` (CDP) | **Works.** Elements, Styles, the box model, Console with the page's errors and warnings. A webview may load `devtools://` URLs, and the guest preload runs there without breaking it. |
| …its start-up | The front end waits **~6 s** before building its UI (`Main._createAppUI` at +6.1 s, every run, whatever the URL parameters), then connects in under 0.5 s. Most likely it waits on an embedder (`InspectorFrontendHost`) call that nothing answers and gives up after a timeout. Not chased yet. |
| `guest.debugger` attached while DevTools is open | Works: a second CDP client (an agent's) can run beside the person's DevTools. |
| Moving the page's webview in the DOM (docking) | The guest is replaced (id 2 → 4); DevTools on the old one is dead. |
| Moving the DevTools webview | Also replaced; the new one reloads its `devtools://` URL. With the WebSocket route that reconnects by itself (the URL carries the socket). |

So there are three working ways to show DevTools, and only one of them keeps DevTools a web surface that behaves like every other window on the board.

## Routes

### 1. Electron's own DevTools window

Right-click → Inspect Element (`guest.inspectElement(x, y)`), and Show Web Inspector (⌥⌘I) on a selected browser window, open Chromium's DevTools in its own macOS window.

- **For:** a few dozen lines; the full DevTools, as fast as Chrome's; works today.
- **Against:** it is not on the board. It floats outside cmd, can't be docked, arranged or put beside the page as the user asked, and it closes whenever the page's webview is re-attached (docking, moving to another workspace).

Worth shipping first anyway: it answers "longing for Inspector" today, and its commands and right-click menu are the ones the later routes keep.

### 2. DevTools in a native view over an Inspector window

An `inspector` window type whose view is an empty, measured box; main lays a `WebContentsView` with DevTools (`setDevToolsWebContents`, which works) over that box's screen rectangle and follows it.

- **For:** Chromium's own DevTools hosting, no start-up delay, no bridge.
- **Against:** everything that made browser windows webviews. The view sits above the app: the palette, sheets, popovers, toasts and menus would draw under it; it doesn't follow `TileMotion` glides, board scrolling, zoom or the Dock's slide. Each of those needs hiding the view and showing a `capturePage()` still in its place, and every new overlay is a new bug. cmd tried hard to never have a native surface on the board.

Not recommended.

### 3. DevTools front end in a webview, CDP bridged by main (recommended)

An **Inspector window** is a window type like any other, whose view holds a `<webview>` showing the DevTools front end that ships inside Electron. Main runs the connection:

```
Inspector window <webview>                      main                           Browser window <webview>
devtools://devtools/bundled/devtools_app.html   WebSocketServer 127.0.0.1:0    guest WebContents
  ?ws=127.0.0.1:<port>/<token>  ── CDP JSON ──▶ /<token> ── sendCommand ──▶   guest.debugger
                                ◀── events ──── debugger "message" ◀──────────
```

The relay is short; the spike's whole bridge was this:

```js
wss.on("connection", (sock, req) => {
  if (req.url !== `/${token}`) return sock.close();
  target.debugger.attach("1.3");
  target.debugger.on("message", (_e, method, params, sessionId) => sock.send(JSON.stringify(sessionId ? { method, params, sessionId } : { method, params })));
  sock.on("message", async (data) => {
    const m = JSON.parse(String(data)), s = m.sessionId ? { sessionId: m.sessionId } : {};
    try { sock.send(JSON.stringify({ id: m.id, result: await target.debugger.sendCommand(m.method, m.params ?? {}, m.sessionId), ...s })); }
    catch (err) { sock.send(JSON.stringify({ id: m.id, error: { code: -32000, message: err.message }, ...s })); }
  });
  sock.on("close", () => target.debugger.isAttached() && target.debugger.detach());
});
```

- **For:** it is a webview, so it is a real cmd window: it glides, docks into a sidebar, sits beside its page on the board, goes under sheets, is selected by a press. No new Chromium build or bundled front end: the one inside Electron's resources matches its Chromium. The same `debugger` attachment is what agents need for console and network (below).
- **Against:** the ~6 s start (to fix before shipping); the bridge (a loopback socket, see Security); one more thing that must follow the guest when it is replaced.

#### How it fits cmd

- **Window type** `inspector` (core `windows/builtin.ts`, `role: "window"`, not offered in File → New or `open` routing), state `{ for: <browser window id> }`. Opened by Show Web Inspector, placed **to the right of its browser window** (the core's `place`), which is the ultrawide layout the user described; the person can move or dock it like any other. Title "Inspector — <page title>", the page's host as its place.
- **One per browser window.** Show Web Inspector on a page that has one selects it instead. Closing the browser window closes its inspector; an inspector restored without its page (state from before a restart, page closed elsewhere) shows an empty view ("This page is closed") with Close.
- **Who connects to what.** The renderer knows both webviews; main owns the sockets. The renderer reports each browser window's guest (`getWebContentsId()` on `dom-ready`, again after every re-attach) and each inspector's wish to connect; main keeps one bridge per inspector (port, token, the current guest) and re-attaches to the new guest when it is replaced. The front end sees its socket close; the inspector reloads its webview (same URL, new connection). The Elements panel starts over, as in Chrome after a reload.
- **Session and policy.** The inspector webview runs in its own partition, `persist:cmd-inspector`. `guestPartitionAllowed` gets a second case: that partition, only with a `devtools://devtools/bundled/` source, and `will-navigate` keeps it there. It keeps the guest preload (presses select the window; the spike showed it doesn't disturb the front end). DevTools' own settings (panels, dock layout, theme) persist in that partition.
- **Commands.** `browser.inspector` (Show Web Inspector, ⌥⌘I, `scope: "window"`, when a browser window with a page is selected), and right-click in a page → Inspect Element. Right-click needs the guest preload to report `contextmenu` with its point (as presses are reported); the window's menu then gains Inspect Element, which opens or selects the inspector and reveals the node under the point: `DOM.getNodeForLocation` on the guest, then main sends the front end an `Overlay.inspectNodeRequested` event for that node (what the element picker sends; not tried yet).
- **Theme.** DevTools follows the system appearance by default, as cmd does; DevTools' own theme setting stays the person's.
- **Device sizes.** cmd's Device Size scales the page with a CSS transform. DevTools' device toolbar emulates through CDP instead (`Emulation.*`); with both on they fight. v1 keeps cmd's and leaves DevTools' alone; worth a look once it ships.

#### Security

CDP is full control of a page and, through `Network`/`Storage`, of the whole `persist:cmd-browser` session (every site's cookies). The person has that in any browser's DevTools anyway; the risk is another local process reaching the socket. So: listen on `127.0.0.1` only, an unguessable token per inspector in the path, one connection per token, `Origin` must be `devtools://devtools`, the listener exists only while an inspector is open and closes with it. The app's own pages are never a target (only guests in `persist:cmd-browser`). Never `--remote-debugging-port`: that exposes every page of the app, including those that carry `window.cmd`, which reaches a shell.

#### The 6 s start

It has to go before this ships. To try, in order: answer the front end's embedder calls with a preload in the inspector partition that defines the `InspectorFrontendHost` methods the front end waits on (it falls back to a stub when none exists; the `devtools://` page seems to get a half-present one); look at what Electron's own DevTools host passes on its URL and in its preferences; failing that, keep one inspector webview warm, created when the first browser window loads a page. Done when an inspector shows the page's DOM in under a second.

### 4. Our own inspector, built from CDP

An element picker, console and network list in cmd's kit, on the same `debugger` attachment. It would look like cmd, but it would be a worse DevTools than DevTools for years. Not for people. It is the right shape for **agents**, though:

## For agents

The coding agents that build the page beside the person need its console errors and failed requests more than its DOM. Route 3's attachment gives them that: main keeps a short ring of each browser window's `Runtime.consoleAPICalled`, `Runtime.exceptionThrown` and `Network.loadingFailed`, and `browser.read` (the `read` tool on a browser window) can return them (`console: true`). The spike showed an agent's `debugger` running beside the person's DevTools. `debugger.attach` allows one client per guest, so main owns that one attachment and both the inspector bridge and the agents' reads go through it (the bridge renumbers request ids). This doesn't depend on the inspector shipping and is its own proposal.

## Plan

1. **Electron's DevTools window (route 1).** Show Web Inspector (⌥⌘I) and Inspect Element in a page's right-click menu, opening Electron's detached DevTools. A small change, useful at once; the commands and right-click reporting carry over.
2. **Spike the start-up delay** (above). Route 3 waits on it.
3. **Inspector windows (route 3).** The window type, main's bridge with its re-attachment, the partition and policy, the commands now opening the window beside the page, an e2e that opens one and reads the Elements tree.
4. **Inspect Element at the point** (`Overlay.inspectNodeRequested`).
5. **Console and network for agents** (separate proposal).

## Open questions

- Should Show Web Inspector open the inspector **docked** in the right sidebar instead of beside the page? Beside is what was asked for and keeps the page's size; the sidebar works when the board is narrow. Maybe a setting, later.
- Inspectors for Magic widgets (iframes inside the app's own page) and the YouTube widget's webview: the same bridge would work for the webview; Magic widgets are frames of the app page, and their CDP target would be the app's own, which route 3 refuses. Out of scope.
- Does the inspector survive a workspace switch without reloading? It does if the board keeps the webview's DOM in place; otherwise it reconnects like after docking.
