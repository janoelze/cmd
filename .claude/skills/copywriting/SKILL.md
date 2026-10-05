---
name: copywriting
description: Write or review any text cmd shows to people: notifications, toasts, tooltips, menu items and buttons, settings titles and descriptions, errors, empty states, confirmations, onboarding, CLI messages. Use whenever you add or change a user-facing string in the app or the CLI, and when the user asks to word, reword or review UI copy.
---

# Writing cmd's UI text

cmd is calm, so its text is calm: **friendly and compact**. It sounds like a helpful colleague at the next desk, someone who uses cmd all day, not a product talking about itself. The voice and the words to avoid come from `docs/15-positioning.md`; this skill turns them into rules per surface. Release notes have their own skill (`changelog`) that follows the same voice.

## Voice

- **Friendly means helpful, not chatty.** Contractions (isn't, you'll, couldn't), "you" for the person. No jokes, no exclamation marks, no emoji, no "Oops", no "Please".
- **Compact.** Cut every word that doesn't change the meaning. A fragment beats a padded sentence: "Summary copied", not "The summary has been copied to your clipboard."
- **What matters first.** Lead with the subject and its state, then details: "agent-playground · needs you", not "An agent in agent-playground is waiting for your input."
- **cmd isn't a person.** No "we", no "I". When a sentence needs a subject, use the thing: "The agent is waiting", "Hooks are installed", or "cmd" when it really is cmd acting ("cmd keeps a copy of every file it changes").
- **Honest.** Say what cmd knows, at the confidence it has it. An agent's own claim is quoted as its words; an inferred state doesn't pretend to be certain.
- **Never blame the person.** When something fails: what happened, then what to do. "Couldn't save the summary. Check that the folder still exists." Not "Invalid path."
- **Plain words, no internals.** Say what people see and can do. No process names (core, PTY host), RPC methods, file names, error codes or flags, unless the person would type them (a setting key, a command).

Avoid (from doc 15, plus UI ones): *supercharge, unleash, revolutionary, seamless, powerful, intelligent, smart, autonomous, agentic, AI-powered, 10x, simply, just, easily, successfully, oops, please, sorry, invalid, error occurred*.

Prefer: *waiting for you, needs you, done, stopped, couldn't, keeps running, side by side, ask for*.

## Conventions

- **Title Case** for menu items, buttons, window titles and section titles, as macOS does: "Pair a Device…", "Restart Core", "Check for Updates…". An ellipsis (…) means more input follows before anything happens.
- **Sentence case** for everything else: notification bodies, toasts, tooltips, descriptions, errors, empty states.
- **Periods only on full sentences.** "Summary copied" (fragment, none). "This file isn't a session summary." (sentence, period). In one string, all fragments or all sentences.
- **Names as the app shows them:** windows, Spaces, the workspace, sidebars, agents, sessions, Magic widgets, the command palette, the Widget Library. Menu paths as `Settings → Agents`. Shortcuts as the menu shows them: ⌘T, ⇧⌘L, ⌥⌘N.
- **Numbers as digits:** "3 terminals", "4 files changed", "7 min".
- **Code and paths** in backticks where Markdown renders (docs, CLI help, settings descriptions); in plain-text surfaces (system notifications, tooltips), in typographic quotes: Allow “rm NOTES.md”?
- **Times and durations short:** 40 s, 7 min, 1 h 5 min; dates as the system formats them.

## Surfaces

| Surface | Shape | Length |
|---|---|---|
| **Notification** | Title: what (project or agent) · state. Body: the one thing worth knowing. | subject ≤ 28 characters (cut), body ≤ 140 |
| **Toast** | The result of something the person just did. An error toast carries an action that fixes it, or isn't a toast. | one short sentence |
| **Tooltip** | Name the control, then its shortcut. Explain only when the name isn't enough. | ≤ 60 characters |
| **Menu item, button** | Verb first, what happens. "Close Space", not "OK". | 1–4 words |
| **Setting** | Title: what it controls. Description: what changes, at a glance. Details (`details`, behind the info button) only when something would surprise: what's sent where, which files change, a format to follow. Most settings have none. | description one line, ≤ 60 characters |
| **Error** | What happened, then what to do. | ≤ 2 sentences |
| **Empty state** | What goes here, and how to get some. | 1–2 sentences |
| **Confirmation** | Title asks or states the consequence; buttons answer it. | title ≤ 1 sentence |
| **CLI output** | Same voice; lower case is fine for fragments ("no events recorded yet"). Errors say what to do. | one line where possible |

### Notifications

People turn notifications off when they cry wolf, so:

- **Only when it matters:** an agent needs the person, finished or stopped while they looked away, or cmd did something on its own they should know about. One notification per event; no reminders for the same thing.
- **Honest urgency.** "Needs you" is urgent (sound). Done and stopped inform. Things cmd did by itself are quiet.
- **Title: subject · state.** The subject is the agent's name if it has one, else its project (the repository's folder name). The state is one of: done, needs you, stopped, and for done with work left running, "done, 1 task still running".
- **Body: snappy, one line, the result.** Read in a second: at most ~70 characters, fragments welcome. "Fixed add(); tests pass." "Summaries are on the summary branch." Never a retelling of steps, never the agent's paragraph pasted in, no filler ("Sure.", "Done.").
- **Written with AI out of the box** when a provider is set up (`notifications.ai`): the fast tier gets the turn's facts (prompt, final message, question, files, error) and writes the body; the title stays cmd's own. Without a provider: the agent's first clause, cut short, then the facts cmd checked ("4 files changed.").
- **Needs you says what it asks:** Allow “rm NOTES.md”? Allow editing “calc.py”? Otherwise the agent's own question.
- **Stopped says why,** in the agent's words: "You've hit your weekly limit · resets Oct 7 at 3am".
- No app name, no "Notification:", no sensitive data beyond what's already on screen.

## Before and after

| Before | After |
|---|---|
| claude is done / (empty) | **cmd-agent-activity · done** / Summaries are on the summary branch. Asks whether to merge. |
| claude needs you / Allow Bash? | **agent-playground · needs you** / Allow “rm NOTES.md”? |
| (nothing on failure) | **cmd · stopped** / You've hit your weekly limit · resets Oct 7 at 3am |
| cmd set up your agents / Added cmd's hook to Gemini CLI (~/.gemini/settings.json), so their state shows in cmd. Settings → Agents → Hooks to change it. | **Gemini CLI set up** / Its state shows in cmd now. Change it in Settings → Agents. |
| Summary copied. | Summary copied |
| An error occurred while connecting to the core. | cmd lost touch with its background process. Reconnecting… |
| Are you sure you want to close this Space? / OK · Cancel | **Close this Space?** Its 3 terminals stop. / Close Space · Cancel |
| No items | No agents running. Start one with ⌥⌘N, or run `claude` in any terminal. |

## Checklist

Before a string ships:

- [ ] Readable at a glance (2 seconds), subject first.
- [ ] Says what the person sees or can do; no internals.
- [ ] Case and period follow the conventions above.
- [ ] Within the surface's length.
- [ ] Friendly and compact: no filler, no hype, no blame, no exclamation marks.
- [ ] Names, menu paths and shortcuts as the app shows them.
