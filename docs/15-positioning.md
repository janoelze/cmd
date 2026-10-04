# Positioning and voice

Date: 2026-10-04. What cmd is, who it is for and how it talks about itself. The README, the website, the app's About box and release notes take their wording from here.

## The story

AI is now good enough that a developer will spend the rest of their working life in terminals, because terminals are how you reach coding agents and that is not going to change soon. But today's terminals are classical in spirit: a window, some tabs, maybe splits. Flipping through 500 iTerm tabs to find the agent that is waiting, the log you were tailing or the server you started yesterday was always stupid, and it doesn't scale now that work moves this fast.

cmd is the daily driver built for that reality. It is a workbench for software projects: terminals, agents, a browser, an editor and small widgets sit side by side, and nothing gets lost or dies. When you need to see something (the CI runs, a queue's depth, a deploy), you ask for it, and an agent builds a live widget for it. You throw the widget away a day later.

It is for the serious, normal work: building and maintaining real software with AI as a collaborator. It is decidedly not one of those projects that runs 600 agents overnight to produce something broken.

## Category

**A software workbench.** Not a terminal (it manages and arranges terminals, and holds more than terminals). Not an IDE (it does not want your editor, your language server or your git UI; your agents and your tools do that work in terminals). The closest existing thing is a terminal manager, and cmd is more than that.

The bet the category rests on: **terminals are the window to agents.** So the workbench is built around terminals, and makes agents first-class in them (it knows what each is doing, keeps them running, and remembers every session).

## Who it is for

Developers who already work with Claude Code or Codex every day, in several projects at once, on a Mac. They are past the novelty phase, and they want a calm, fast place to work, not a dashboard of autonomous agents. They are keyboard people who care about tools.

Not for: people who want an AI IDE, people who want to hand a backlog to a swarm and come back in the morning, or people who don't use a terminal.

## What it is / what it isn't

| It is | It isn't |
|---|---|
| A daily driver, open all day | A tool you open for a batch job |
| A desk: everything you're working on, side by side | A tab bar |
| You plus a few agents, on real projects | An agent farm |
| Terminals, made agent-aware | An IDE with a chat panel |
| Disposable widgets you make by asking | A dashboard you configure |
| Calm: what needs you is on top, the rest waits | A wall of notifications |

## Three pillars

Lead with the desk, because that is what you see first and what replaces the 500 tabs. Agents are why it exists. Magic widgets are the surprise.

1. **One desk for everything you're working on.** Terminals, agents, browser, editor, Markdown and widgets are all windows on the same desk. Arrange them as a grid, a scrolling strip or an infinite canvas, or focus on one. Every window is one keystroke away from the command palette.
   *Proof:* four layouts, ⌘K finds anything, `open README.md` from a shell opens it on the desk, spaces per project.
2. **Agents live in terminals, and cmd knows them.** Claude Code, Codex and others are recognised in any terminal, with no setup. The one that is waiting for you is on top. Terminals outlive the app, and every past session is searchable and resumable.
   *Proof:* the "Needs you" group, ⌃⌘J, the Dock badge; the core and PTY host keep terminals running across quits and updates; full-text search over Claude, Codex, Qwen and Copilot transcripts.
3. **Magic widgets: ask for a window, throw it away tomorrow.** Type what you want to see ("my open merge requests", "the last CI runs", a JSON URL) and an agent builds a live widget for it in your theme. It refreshes on its own without calling the model. When you no longer need it, close it.
   *Proof:* typed `data.ts` on Deno with declared permissions, checked renders, a read-only sandbox, versions and Fix.

Everything else (themes, the CLI, find in scrollback, inline images, notifications) goes under "Also" and doesn't compete with the pillars.

## Voice

The product is calm, so the copy is calm.

- **Plain and concrete.** Say what happens: "the agent that is waiting is on top", not "intelligent attention management".
- **First-hand.** Written by someone who uses it all day. Examples come from real work: CI runs, a deploy, a flaky test.
- **Short sentences, no exclamation marks.**
- **Confident without hype.** No claims about productivity multipliers, no "10x", no "autonomous".
- **Honest about scope.** macOS on Apple silicon, bring your own API key for widgets, the CLI isn't bundled yet.

Avoid: *supercharge, unleash, revolutionary, 10x, autonomous, agentic, AI-powered, seamless, next-generation, swarm, army of agents, vibe*.

Prefer: *side by side, window, waiting for input, keeps running, ask for, live*.

## Copy bank

Plain and descriptive: say what cmd is and does, not what it will do for you. (2026-10-04: an earlier, more pitch-like set, "a workbench for building software with AI… nothing gets lost, nothing dies", was dropped as too salesy.)

**Line:** A macOS app for running terminals and coding agents side by side.

**Lede (website, README):** A macOS app for running terminals and coding agents side by side, with web and file browsers, an editor, and widgets an agent builds live when you ask.

**What it isn't:** It isn't an IDE and has no agent of its own: you bring Claude Code, Codex or whichever agent you use.

**Short descriptions** (package.json, About box, GitHub repo):
- GitHub: "A macOS app for running terminals and coding agents side by side, with web and file browsers, an editor and Magic widgets."
- package.json / About: "Terminals and coding agents, side by side"

Below the lede, list features as plain title + one sentence (the website's Features grid), not as benefits.

## How we talk about competitors

We don't name them in public copy. Internally, the differences are:

| They | We |
|---|---|
| **cmux** is a terminal with agent notifications | A desk with more than terminals; transcript search across agents; widgets |
| **Superset, Conductor** run many agents in parallel worktrees | One developer with a few agents, on the actual project |
| **Warp** is an AI terminal with its own agent | Bring your own agents (Claude Code, Codex); cmd hosts them, it doesn't replace them |
| **IDEs (Cursor, Zed)** put an agent in the editor | cmd leaves the editor alone and puts the editor on the desk |

## Naming in the product

- **Magic windows → Magic widgets.** "Window" is what everything on the desk is, so a widget is one kind of window. Copy says *Magic widget*, and the command is "New Magic Widget". Code identifiers (`magic.*` settings, the `widget` window type) already fit.
- **Windows** are the things on the desk. **Spaces** group them by project. **Agents** are terminals with a coding agent in them. **Sessions** are an agent's transcript, live or past.
- The **desk** is the word for the main area (grid, strip, canvas and focus are ways of arranging it).

## Name and icon

**cmd**, with the ⌘ icon. Decided 2026-10-04 after two rounds of name research (kerf, tisch, werk, pult and about 40 others; "atelier", "jig" and "easel" already belong to products like this one).

Why it holds up: ⌘ is the key you press for every command on a Mac, and cmd is a keyboard-first app where every action is a command (⌘K finds anything). It is short to type as a CLI (`cmd spawn claude "fix the tests"`). Write it lowercase, `cmd`, in body text and in headings.

The known costs, accepted: it's hard to search for (so use "cmd for macOS" or "cmd workbench" where search matters, e.g. the website's title and the GitHub description), it shares a name with Windows' `cmd.exe` (cmd is macOS-only), and the ⌘ glyph is Apple's (fine as an icon, never as a logo in our own lettering).

The status colours (orange: needs you, blue: working, green: done) stay in the product. They're how cmd shows attention, not part of the brand mark.
