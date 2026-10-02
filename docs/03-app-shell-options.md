# App shell options

Researched 2026-10-02. Memory and startup figures are typical community numbers, not our own benchmarks. "(unverified)" marks claims I could not confirm from a primary source.

## What we judged the shells on
- Can it run a PTY?
- Can it be tested end-to-end?
- Can plugins be written in TypeScript and hot-reloaded?
- Can the UI be customized without limits, including an **infinite canvas** of terminals?
- Performance and memory.

## Comparison

| Shell | Memory / startup | PTY | Testing | Plugins / hot reload | Canvas freedom | Maturity |
|---|---|---|---|---|---|---|
| **Electron** (Chromium + Node) | Heaviest: about 150–300 MB idle, 80 MB+ bundle | `node-pty` + xterm.js / ghostty-web, the setup VS Code, Hyper, Tabby and Superset use | **Best**: Playwright `_electron`, Vitest. Chromium is the same everywhere. | Vite hot reload; plugins in `utilityProcess` / workers | Full DOM/CSS/WebGL; any canvas library (React Flow, tldraw, custom) | Very mature |
| **Electrobun** (Bun + WKWebView, optional CEF) | About 12–14 MB bundle, kB-sized delta updates | `Bun.Terminal` / `Bun.spawn({terminal})` gives a native PTY with no native module | Typed RPC is easy to mock. No official Playwright support for WKWebView (unverified); can bundle CEF and use the Chrome debugging protocol. | Built-in hot reload; Bun runs TS natively | Same as web, but WKWebView WebGL performance is weaker | v1 shipped Feb 2026; young; documentation gaps |
| **Tauri v2** (Rust + WKWebView) | Small | `portable-pty` (Rust) relayed to the webview. TerminalX hit flooding and memory growth with xterm WebGL in WKWebView. | **Weak on macOS**: `tauri-driver` doesn't support macOS. Workarounds: CrabNebula's driver, `tauri-plugin-playwright`. | UI hot reload; backend changes need a Rust rebuild | Same as web (WKWebView) | Mature (Conductor uses it) |
| **Wails v3** (Go + WKWebView) | Small | `creack/pty` | Same WKWebView gap as Tauri | Go backend | Same as web | Beta |
| **Native Swift/AppKit + libghostty** | **Best** (Metal) | libghostty; embedding API not yet stable | XCTest / XCUITest, no TS | No hot reload; TS plugins only by embedding JavaScriptCore or running them in separate processes (the Raycast model) | Possible but manual: you build a pannable, zoomable view of Metal layers and handle hit-testing, focus and zoom crispness yourself | Proven by Ghostty and cmux |
| **GPUI** (Zed) | Excellent | `alacritty_terminal` | Rust tests | Rust only | Possible but it is your own GPU UI work | Not a stable standalone crate yet |
| **Flutter** | Good | `flutter_pty` + `xterm.dart` forks | Strong widget tests | Dart only | Good (`InteractiveViewer`) | The terminal libraries are fragmented |

## What the infinite canvas changes
Web-based shells make freeform layouts close to free:
- Each terminal is a DOM node positioned in a transformed container.
- Canvas libraries (React Flow / xyflow, tldraw) already provide panning, zooming, a minimap, selection and snapping.

The hard part is the **terminal renderer**: how many live instances are affordable, and what happens to text when zoomed. See [02-terminal-foundations.md](02-terminal-foundations.md).

Natively (AppKit), each terminal is its own Metal-layer view. Panning and zooming many of them is doable but entirely hand-rolled, which slows the "mod it whenever I want" loop.

## Recommendation
1. **Electron + TypeScript** is the default. It has the best testing story, the most prior art and the fewest surprises, and memory is the only real cost. Keep the renderer a thin view over a separate core process.
2. **Electrobun** is the lighter alternative with the same TS ergonomics and a native PTY. It is young, so revisit it in 6–12 months. Keeping the core in a separate process and RPC typed with a shared schema makes a later switch cheap.
3. **Tauri** loses to both: Rust is required for the backend and macOS end-to-end testing is weak.
4. **Native Swift + libghostty** is the performance ceiling. It works against "TypeScript, very testable, mod it fast". Choose it only if terminal rendering performance turns out to be the bottleneck in practice.

**Architectural hedge, whichever shell is chosen:** a **separate core process (daemon)** owns the PTYs, plugins, the index and the state, and the UI attaches to it over a socket, as Wave and cmux do. This gives:
- Sessions that survive UI restarts and reloads, which matters during heavy hot-reload development.
- A core that can be tested headlessly.
- A CLI almost for free (`cmd notify`, `cmd open`, …).
- A UI shell that can be swapped later.

## Sources
- https://blackboard.sh/electrobun/
- https://news.ycombinator.com/item?id=47069650
- https://github.com/oven-sh/bun/pull/25415
- https://github.com/terminalx-ai/terminalx/issues/232
- https://v2.tauri.app/develop/tests/webdriver/
- https://takazudomodular.com/pj/zudo-tauri/docs/frontend/playwright-engine-pitfall/
- https://lib.rs/crates/tauri-plugin-playwright
- https://v3.wails.io/blog/wails-v3-beta/
- https://github.com/realab/gpui-standalone
- https://www.gpui.rs/
- https://mitchellh.com/writing/libghostty-is-coming
- https://dev.to/yuu1ch13/what-it-takes-to-embed-libghostty-in-a-swift-app-six-months-of-lessons-1m64
- https://github.com/klc/xterm3
- https://performance.dev/the-conductor-rewrite
