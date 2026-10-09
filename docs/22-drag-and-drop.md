# Drag and drop

> Status (2026-10-06): built on branch `dnd`. Files and links drag between Finder (or any app), terminals, file browsers and the rest of the board, in both directions. Not built: see "Not yet" at the end. Prompted by feedback on 0.14.0 asking for file browser → terminal, Finder → terminal and Finder → file browser.

## What people see

| Drag | Onto | What happens |
|---|---|---|
| Files (Finder, a file browser row, a title icon) | a terminal | Their paths are typed, escaped the way Terminal.app does (`My\ Files/shot.png`), with a space after. Agents take dropped images as attachments. |
| One folder, with ⌘ held | a terminal | `cd` and its path are typed; Return is yours to press. |
| A link or text | a terminal | It's typed. Paste protection checks it like any paste. |
| Files | a file browser | They go into the folder under the pointer: a folder's row means that folder, a file's row means its folder, empty space means the root. Moved on the same disk, copied from another, ⌥ always copies (Finder's rules). Resting on a closed folder opens it after 0.7s. The window gets the accent ring and the target folder's row is marked. |
| Files or links | any other window, or empty board | They open, routed like `open` or the palette would (a text window, a browser, a file browser for a folder). |
| Files | the top bar, status bar or anywhere outside the board | Refused. The page never navigates to the file. |
| A file browser's row | Finder, Mail, Slack, a page's upload field, any cmd window | A real file drag, the same as dragging it out of Finder. |
| A window's title icon (the Mark) | the same | A text, Markdown, PDF or image window drags its file, a file browser its folder, a terminal its working directory, a browser window its page's link. Like the icon in a macOS document's title bar. |

Browser windows and Magic widgets are pages in their own process, so drags over them go straight to the page, as in Chrome.

## How it works

**Every file drag is a native file drag.** cmd doesn't invent its own drag format to move files between its windows. When a drag starts on something that is a file, `drags.ts` cancels the page's drag and asks the main process to start a macOS one (`webContents.startDrag({ files, icon })`, IPC `start-file-drag`, icon from `app.getFileIcon`). Wherever that drag lands, Finder or cmd itself, it carries real files. So cmd's drop targets only ever handle one kind of input: the drag Finder makes. Links are the exception: the title icon of a browser window sets `text/uri-list` and `text/plain` on the page's own drag, which every app already understands.

**One router takes every drop.** `drops.ts` (installed at startup in `main.tsx`) listens for `dragenter`, `dragover` and `drop` on the document in the capture phase. For each event it:

1. Reads what's dragged. During the drag only the kinds are readable (`Files`, `text/uri-list`, `text/plain`); on drop, `readDrop` gets file paths (`webUtils.getPathForFile`, plus `file:` URLs from a uri-list), other URLs and text.
2. Finds the window under the pointer: the closest `[data-pane]`, which board tiles and docked sidebars both carry.
3. Asks that window's registered `DropTarget` what a drop would do (`over` → `copy` / `move` / `link` / null). If the window has no target or refuses, the fallback opens files and links: over a window, or over `.main`, the board.
4. Shows it: `.drop-over` on the window (an accent ring, through the tile frame), and the effect as the pointer's badge, reduced to one the drag's source allows (`allowedEffect`; a drop with an effect the source doesn't allow is refused by the browser).
5. If no one takes a file drag, it still `preventDefault`s it, with `dropEffect = "none"`, so nothing navigates. Text drags nobody takes go on to editors and fields (CodeMirror moves selected text itself).

Marks are cleared when `dragover` stops coming for 300 ms. Chromium sends one about every 50 ms while a drag is over the page, even at rest. `dragleave` can't tell leaving the window apart from moving between elements, and a cancelled drag needn't send one.

**Drop targets** register per window: `registerDropTarget(paneId, { over, drop, leave? })`, which returns the removal. The window's view code calls it, not the window type registry, because a target needs the view's live state (the file browser's rows, the terminal's xterm). The latest registration for a pane wins; removing an older one is a no-op.

- Terminals (`terminals.ts`, in `#dom`) register when the xterm host is created and unregister in `dispose`. Text goes through `paste()`, so paste protection applies.
- The file browser (`FilesView.tsx`) registers once per window and reads its current rows through a ref. `folderAt` maps the element under the pointer to a folder. Spring-loading is timed in `over` (it's called on every `dragover`). The drop calls `fs.transfer` and then expands the folder and selects the first result.

**The core** has one new method, `fs.transfer { paths, dir, op: "copy" | "move" | "auto" } → string[]` (`fileops.ts → transferPaths`). It checks every path before touching any (missing paths, a folder into itself). It never overwrites: a taken name gets " 2", " 3"… (`a 2.txt`, `folder 2`). A move within the folder something's already in does nothing. `auto` moves when source and folder are on the same device (`st_dev`) and copies otherwise, so dragging from a USB stick never deletes the original. A move across disks (`EXDEV`) copies, then deletes. Remote clients may call it with control access, and only for paths and resulting names they're allowed (`remote/policy.ts`).

**Dropped paths are escaped like Terminal.app's** (`paste.ts → shellWord`). This changed from single quotes: Terminal.app, iTerm and Ghostty all backslash-escape, so that's what agents expect when they look for dropped image paths. Names with a control character (a newline) are still single-quoted, since a backslash before a newline joins lines.

## Guards

A drop is one stray release away from moving something big, and cmd has no ⌘Z for files the way Finder does. So:

- **Protected items stay put** (core, `protectedReason`): `/` and everything at its top (`/Applications`, `/System`, `/Users`, `/tmp`…), disks under `/Volumes`, home folders, and in your home its standard folders (Desktop, Documents, Downloads, Library…) and dotfiles (`~/.ssh`, `~/.config`). Moving one is refused. Copying one is allowed, except a whole disk or home folder. Because the check lives in `fs.transfer`, it covers every caller, remote clients included.
- **A native alert says why** whenever the core refuses a drop: a protected item, a folder into itself, a file that's gone. Bold line: "Couldn't move “Documents”"; below it, the reason: "macOS and your apps expect “Documents” where it is."
- **A native confirmation comes before moving what open windows use** (`windowsUsing`): a terminal working in it, a file browser rooted in it, a file open in a window. That always includes a title-icon drag. Windows keep the path they had, so they'd lose track of it. "Move “src” into “box”?" · Move / Cancel.
- **Every move can be undone** from its toast ("Moved “a.txt” to “box”" · Undo), which moves the items back to the folders they came from. Copies get no toast: the copy is selected, and the original is untouched. Items that `auto` copied from another disk are left out (`fs.resolve` shows the original is still there).

A text window whose file is moved or deleted keeps its text and no longer throws when the file disappears.

## Files

| File | Role |
|---|---|
| `apps/desktop/src/renderer/src/drops.ts` | the router, `registerDropTarget`, `readDrop`, `allowedEffect`, the open fallback |
| `apps/desktop/src/renderer/src/drags.ts` | `dragFiles` (native file drag), `dragLink` |
| `apps/desktop/src/renderer/src/paste.ts` | `shellWord`, `parseUriList` (pure, tested in `apps/desktop/test/paste.test.ts`) |
| `apps/desktop/src/main/index.ts` | IPC `start-file-drag` → `startDrag` |
| `apps/desktop/src/preload/index.ts` | `cmd.startFileDrag(paths)`, `cmd.pathForFile(file)` |
| `apps/desktop/src/renderer/src/components/FilesView.tsx` | rows as drag sources; the folder drop target |
| `apps/desktop/src/renderer/src/components/TileTitle.tsx` | the Mark as a drag source (`fileOf`, `urlOf`) |
| `apps/desktop/src/renderer/src/terminals.ts` | the terminal drop target |
| `packages/core/src/fileops.ts` | `transferPaths`, `protectedReason` (tested in `packages/core/test/fileops.test.ts`) |
| `apps/desktop/src/renderer/src/model.ts` | `windowsUsing` (tested in `apps/desktop/test/windows-using.test.ts`) |
| `e2e/drops.mjs` | `pnpm e2e:drops`: the whole flow in the built app |

## Testing

`pnpm e2e:drops` builds the app and drives it with CDP's `Input.dispatchDragEvent`. Those are trusted drags with real file paths (`getPathForFile` resolves them), the same as a drag from Finder, modifiers included. The test covers terminals (an escaped path, a link, ⌘-drop types `cd`), the file browser (onto the root, onto a folder's row, ⌥ copies, the marks while hovering and after a cancel), a text window (opens the file), the status bar (refused), the guards (an alert for a refused move, the confirmation for a file open in a window with Cancel and Move, Undo from the toast; native dialogs are stubbed in the main process to record them and choose the answer), and drags out. Protected items are covered by the core's unit tests only: an e2e test that drags `~/Documents` would move it if the guard ever broke. A native drag session can't be scripted, so for drags out the test stubs `startDrag` in the main process and checks which files reached it.

Spike findings on the way:
- The 0.14 Finder → terminal drop worked under trusted drags; it only didn't cover anything else.
- A CDP file drop on an unhandled part of the page didn't navigate, but the router refuses stray file drops anyway, as plain Electron would load the file in place of the app.
- A fresh `CMD_HOME` shows onboarding over everything: tests have to get past it before dropping.

To check by hand (drags that leave the app or start in it can't be automated): drag a row from the file browser to Finder, to the Desktop and onto a terminal; drag a title icon into Claude Code.

## Decisions

- **Native drags, not a private format.** One drag kind for every source and every target, and it's correct outside cmd for free. The cost: a drag's own data can't carry extra fields (like the source window), and none of the targets so far need them.
- **Finder's move/copy rules** in the file browser, with the decision in the core (`auto`), which can see devices. The badge can't see devices during the drag, so it shows "move" unless ⌥ is held or the source allows only copy. In that case it says copy while the file browser still moves (same disk), as moving rows between folders is what you'd expect inside an explorer.
- **⌘-drop on a terminal types `cd <path>`** without Return: what runs stays visible and up to you. It types `cd` for any single item; for a file, cd fails visibly.
- **Windows without a target open what's dropped** (text, Markdown, PDF, image, the Navigator). Dropping a file into a text editor opens it rather than inserting its contents or path.

## Not yet

- Several rows at once: the file browser selects one row, so it drags one file.
- ⌘Z for moves (the toast's Undo is the only way back).
- Dragging a path out of terminal output (⌘-drag a path link).
- Dropping on a Space in the switcher, or a sidebar row in the Navigator, to target that window or Space.
- Remote and web clients: `fs.transfer` is allowed by the remote policy, but no remote client drags yet.
- A copy badge that knows about other disks before the drop.
