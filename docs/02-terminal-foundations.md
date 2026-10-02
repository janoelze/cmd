# Terminal foundations

Researched 2026-10-02. Versions and benchmarks change fast. Benchmarks come from blogs, issues and tweets, not controlled studies.

Requirements this has to meet:
- mature
- fast
- testable, preferably TypeScript
- many live terminals at once, for an **infinite canvas** (20–50 terminals, pan and zoom, minimap)

## Candidates

### libghostty-vt (Zig, C API, MIT)
- **What it is:** Ghostty's terminal core, with zero dependencies (not even libc).
  - SIMD parsing
  - terminal state, reflow, scrollback
  - Kitty graphics, tmux control mode
  - a key encoder that includes the Kitty keyboard protocol
- **It does not render.** A `RenderState` API reports which rows changed. Ghostty's own Metal and OpenGL renderers use the same API.
- **Maturity:** alpha, with no stable API. Overscan and row identity (#14404) and a `render_hold` callback were added in Sept 2026. It will get its own release cycle, separate from the Ghostty app.
- **Bindings:** Rust (`libghostty-vt` 0.2.2, community-maintained), Go (`go-libghostty`), Swift/SwiftPM, a TypeScript/Node-API binding, a WASM build, Python and .NET. See awesome-libghostty.
- **Speed:** Mitchell claims more than 2× other "fast" terminals. A blog measured 150 MB of ASCII in 575 ms vs 1.2 s for Alacritty.
- **Full libghostty with Metal (GhosttyKit.xcframework)** is what cmux, `p1rallels/infinite` and `twaldin/canvas` embed. It is **not a public, stable API**: apps patch and build it from source, and cmux ships a fork and has hit crashes in it.

### Web wrappers around libghostty-vt
| Project | What | Status |
|---|---|---|
| **ghostty-web** (Coder, MIT) | About 400 KB WASM with an **xterm.js-compatible API** (swap the import). Renderer reportedly Canvas 2D with dirty lines (not confirmed in the repo). | About 2.9k stars, used in Coder Mux. A benchmark saw 0.4.0 crash with memory errors on Unicode writes during rendering tests. |
| **restty** (MIT) | WebGPU with WebGL2 fallback, TS text shaping, multi-pane, plugins, a `restty/headless` entry for tests, an xterm compatibility wrapper | Early release, about 410 stars |
| **gespenst** (MIT) | Unmodified `ghostty-vt.wasm`. WebGPU, WebGL2 or 2D, in a worker or a **shared worker that multiplexes many terminals** | Early |

xterm.js maintainers opened #5686 (Feb 2026) to explore adopting libghostty, with "no promises".

### xterm.js 6.x (TypeScript, MIT) + node-pty
- **Who uses it:** VS Code, Hyper, Tabby, Wave, Superset and most canvas-terminal projects.
- **What it offers:**
  - addons
  - a parser hook API (for custom OSC handlers)
  - `@xterm/headless` for tests and server-side state
  - serialize and search addons
- **6.0:** removed the canvas renderer, leaving DOM and WebGL. Added synchronized output (mode 2026), ligatures and ESM.
- **Known pain points in 2026:**
  - The WebGL renderer is corrupted in Safari/WebKit on macOS (#5816; fix PR #5883 not merged). **This hits Tauri and Electrobun (WKWebView), not Electron.**
  - Inside WKWebView, xterm.js doesn't detect Safari, so it skips its WebKit workarounds.
  - The shared glyph atlas gets corrupted across many mounted terminals in long sessions (seen in hermes-agent and hive-desktop).
  - About 7 MB heap per terminal for history, in one benchmark.

### Native and Rust options
| Library | Notes |
|---|---|
| **alacritty_terminal** (Rust, Apache-2.0) | 0.26. The core inside Zed's terminal and Horizon. No renderer; its API is shaped around Alacritty's own needs. |
| **wezterm-term / termwiz** (Rust, MIT) | `wezterm-term` is not on crates.io, so people use forks. Last WezTerm release was 2024-02. Avoid. |
| **Rio** (`rio-vt`, `sugarloaf` WebGPU) | Niche. |
| **SwiftTerm** (MIT) | Mature (CodeEdit, Secure ShellFish, La Terminal). Thread-safe, headless mode. Its Metal renderer is experimental. Slower than Ghostty. |
| **libvterm** (C) | Neovim's. Stable, slow-moving. |

## PTY layer
| Option | Notes |
|---|---|
| **node-pty** 1.1 (Microsoft) | N-API with prebuilds for darwin arm64/x64. Rebuilds against Electron cause trouble again and again; run it in a separate Node process (not Electron's renderer) and it is fine. |
| **Bun.Terminal** / `Bun.spawn({terminal})` | Since Bun 1.3.5. POSIX only. No native module needed. |
| **portable-pty** (Rust) | WezTerm's. |
| SwiftTerm `LocalProcess` | Native Swift. |

**Whatever you choose, add flow control (backpressure) between the PTY and the renderer.** TerminalX ran into IPC flooding and memory growth without it.

## Performance numbers (take with salt)
- **fregat benchmark** (M1 Air, Chromium):
  - parser throughput: xterm WebGL 63.6 MB/s, xterm DOM 68 MB/s, ghostty-web 0.4.0 65.6 MB/s, their custom WebGPU renderer 164–360 MB/s
  - retained memory: xterm 7.3 MiB vs custom 0.4 MiB
  - write latency (p50): xterm WebGL 8 ms vs custom 14 ms
- Vendor claims: libghostty WASM is "a lot a lot faster" than xterm.js at I/O, reflow and render prep; ghostty-web does about 2.3M vs 235k chunks/s for xterm.js v6.
- Native: Ghostty is about 2 ms input latency and 80–100 MB RAM; WezTerm is about 320 MB.

In practice: for agent TUIs and normal shells, xterm.js in **Chromium** is fast enough. Throughput only matters for `cat`-ing huge logs.

## The infinite canvas: the requirement that matters most

### Problems with one xterm.js WebGL terminal per canvas node
1. **WebGL context limit:** browsers keep about 16 live WebGL contexts and drop the oldest. The xterm WebGL addon uses one context per terminal. Issue #4379 ("share one context across dozens of panes") has had no maintainer response.
2. **Blur on zoom:** under a CSS `transform: scale`, WebGL bitmaps are resampled and look blurry. The fix (nodeterm #986) is to re-render at an effective DPR of `dpr × zoom` once the zoom stops, capped at about 3. The DOM renderer stays sharp but is slower.
3. **Offscreen terminals:** xterm stops painting offscreen terminals (IntersectionObserver) but keeps parsing, which is good. `visibility:hidden` defeats this, so don't use it.
4. Glyph atlas corruption across many mounted instances, mentioned above.

Workarounds in use:
- an LRU pool of live WebGL contexts
- the DOM renderer for the rest
- releasing contexts of minimized terminals

### The architecture that fits better
**Keep terminal state apart from rendering:**

```
core process:  PTY ──► VT state (libghostty-vt or @xterm/headless) per session
                                   │ (dirty rows / snapshots)
UI:            ONE canvas renderer (WebGL2/WebGPU) draws every visible terminal as a viewport
               ├─ at zoom ≥ ~0.6: full glyph rendering, sharp at real zoom (redrawn, not scaled)
               ├─ at low zoom: level of detail → cards (title, agent state, last N lines)
               └─ minimap/thumbnails: cheap low-detail redraw from the same state
```

- This removes the context limit and the blur, and minimaps become nearly free.
- restty and gespenst are heading this way; xterm.js is not.
- The catch: you own a renderer. It is a well-understood problem (glyph atlas plus instanced quads), but it is real work.

### Native equivalent
`p1rallels/infinite` hosts several GhosttyKit Metal surfaces and **freezes each surface while zooming**, so the text is scaled, not re-rasterized. A cleaner native approach: libghostty-vt plus your own Metal renderer drawing every terminal into one `MTKView`, with a shared atlas. Maestri (native) claims "pixel-perfect TUI rendering at every zoom level".

### Existing canvas-terminal projects to study
| Project | Stack |
|---|---|
| **TermCanvas** | Electron + React + xterm.js WebGL + Zustand, MIT. Status dot per agent. |
| **nodeterm** | Electron + React Flow + xterm.js + tmux. Fix for zoom blur in #986/#992. |
| **Horizon** | Rust + egui + wgpu + alacritty_terminal, MIT. Pinch zoom, minimap. |
| Terminal Canvas | Electron |
| Collaborator | — |
| ccanvas | — |
| termscape | — |
| Cate / Catenary | canvas IDE: terminals, Monaco, browsers, worktrees |
| TerminalX | — |
| RACE | custom renderer, claims 144 fps |
| Maestri | native; you draw lines between agents so they can talk |

## Comparison

| Foundation | Renders? | Maturity | Speed | Canvas (many instances / zoom) | Testability |
|---|---|---|---|---|---|
| libghostty-vt | No (RenderState) | Alpha, API changing | Best | Excellent with your own shared renderer | Headless core |
| GhosttyKit (full) | Metal | No public API, forks needed | Best | One surface per terminal; zoom scales the bitmap | Hard |
| ghostty-web | Canvas 2D (?) | Young; Unicode bugs | ≈ xterm in one benchmark | No WebGL limit | xterm API |
| restty / gespenst | WebGPU/WebGL2/2D | Early | Good | Built for multiple panes / shared worker | Headless entry |
| **xterm.js 6** | DOM/WebGL | **Very mature** | Adequate | 16-context limit, blur, atlas bugs; workarounds known | **Excellent** |
| alacritty_terminal | No | Stable | Fast | Build the renderer yourself | Rust |
| SwiftTerm | CG/Metal (experimental) | Mature | Moderate | One view each | XCTest |

## Recommendation
1. **Hide the terminal behind your own interface from day one.** Define a `TerminalSession` (state, input, resize, snapshot, events) and a `TerminalView`, so the engine can be swapped.
2. **v1 (ship fast):** xterm.js 6 in Electron's Chromium. Use the WebGL addon for focused and visible terminals with an LRU pool of about 8 contexts, and DOM or snapshot cards for the rest. Re-render at `dpr × zoom` once zooming settles.
3. **Headless state in the core process.** Use `@xterm/headless` now, or the libghostty-vt Node/WASM binding later. Each session's screen and scrollback then survive UI reloads, can be serialized for restore, and give thumbnails and cards their "last lines" without a live renderer.
4. **v2 (once the canvas matters):** a single shared WebGL2/WebGPU renderer over libghostty-vt state, either by adopting restty or gespenst or writing your own. Expect this to happen around the time libghostty's API stabilizes.

## Sources
- https://mitchellh.com/writing/libghostty-is-coming
- https://github.com/ghostty-org/ghostling
- https://github.com/ghostty-org/ghostty/pull/14404
- https://lib.rs/crates/libghostty-vt
- https://pkg.go.dev/github.com/mitchellh/go-libghostty
- https://github.com/Uzaaft/awesome-libghostty
- https://x.com/mitchellh/status/2074167186785226899
- https://x.com/mitchellh/status/2088378990998524206
- https://github.com/coder/ghostty-web
- https://github.com/wiedymi/restty
- https://gespenst.dev/
- https://github.com/xtermjs/xterm.js/issues/5686
- https://github.com/xtermjs/xterm.js/releases
- https://github.com/xtermjs/xterm.js/issues/5816
- https://github.com/xtermjs/xterm.js/issues/4379
- https://github.com/ShaulLavo/fregat/pull/235
- https://github.com/eneskirca/nodeterm/issues/986
- https://github.com/orrybaram/manor/issues/300
- https://github.com/diffplug/dormouse/pull/612
- https://github.com/NousResearch/hermes-agent/issues/76102
- https://crates.io/crates/alacritty_terminal
- https://github.com/migueldeicaza/SwiftTerm
- https://www.npmjs.com/package/node-pty
- https://bun.com/blog/bun-v1.3.5
- https://docs.rs/portable-pty
- https://github.com/terminalx-ai/terminalx/issues/232
- https://github.com/manaflow-ai/cmux
- https://github.com/p1rallels/infinite
- https://github.com/twaldin/canvas
- https://www.themaestri.app/en
- https://github.com/blueberrycongee/termcanvas
- https://github.com/eneskirca/nodeterm
- https://github.com/peters/horizon
- https://github.com/collaborator-ai/collab-public
- https://github.com/alexnieves-cs/terminal-canvas
- https://thecatenary.app/
- https://scopir.com/posts/best-terminal-emulators-developers-2026/
