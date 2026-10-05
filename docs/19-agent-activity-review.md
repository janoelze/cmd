# Reviewing real agent activity data

> Status (2026-10-05): handoff. cmd 0.11.0 shipped the activity layer ([18-agent-activity.md](18-agent-activity.md)) and started recording on the author's Mac the same day. This doc is the plan for the first review of real data, to be done after a few days of normal use. Nothing here is built yet; the outcome is a list of fixes to the adapters and rules, new fixtures, and a decision on what the UI can rely on.

The activity layer was designed from documentation and five recorded sessions, all headless (`claude -p`, `codex exec`) in a scratch repository. Real use differs: interactive sessions, permission prompts answered by a person, Esc interrupts, long turns, background subagents, several agents in one repository, folders that aren't repositories. This review checks the data against that, before any feature (notifications, the Agent Activity widget, summaries) is built on it.

## 1. Collect

Prerequisite: cmd ≥ 0.11.0 running as the installed app (development builds don't set up hooks by themselves). Check:

```sh
cmd agents homes       # every Claude profile and Codex home, with how each was found
cmd hooks              # cmd's hook installed in each of them
cmd agents coverage    # events arriving per agent
```

Use agents normally for a few days. Make sure the data includes, at least once:

- [ ] Interactive Claude sessions with a permission prompt you **allow**, and one you **deny**
- [ ] An **Esc interrupt** in Claude mid-turn (and one mid-tool-call, e.g. during a long `npm test`)
- [ ] `/clear` and a resumed session (`claude --resume`) in the same pane
- [ ] A compaction (long session, or `/compact`)
- [ ] A background subagent (Claude's Agent tool) that finishes after the main turn
- [ ] Interactive Codex with an approval prompt, and an Esc in Codex
- [ ] Two agents working in **the same repository** at once
- [ ] An agent working in a folder that **isn't a git repository**
- [ ] A turn where the agent edits files through the shell (sed, a Python script)
- [ ] A session that runs into an API error or rate limit (if it happens)

Note the time of each deliberate case (interrupt, deny, …) so it can be found in the data.

Then export, **within 14 days** (events and turns older than that are pruned):

```sh
cmd agents export --anonymize --out ~/src/agent-activity-export.jsonl
```

`--anonymize` only rewrites the home folder to `~`. The file still contains prompts, commands, file contents in tool payloads (cut at 4 KB per string) and final messages. **Don't commit it**, don't paste it into issues; keep it local. What goes into the repo are fixtures, cut down and rewritten (step 4).

The same data is in the app's SQLite file for ad-hoc queries: `~/Library/Application Support/cmd/cmd.sqlite`, tables `agent_events` (raw payload in `doc`, provenance in `schema`, `cmd`, `hook`, `agent_version`), `agent_turns` (`doc` is an `AgentTurn`), `agent_homes`, `schema_versions`. Open it read-only (`sqlite3 -readonly`); the core writes to it.

## 2. The export file

JSONL ([18-agent-activity.md](18-agent-activity.md), "Formats and versions"):

1. A header: `{format: "cmd-agent-activity", version, schema, turnFormat, exportedAt, cmd, since, anonymized}`. Check `version`, `schema` and `turnFormat` against the constants in `packages/protocol/src/activity.ts` before analysing; if they differ, the export is from another cmd.
2. `{type: "turn", …AgentTurn}`: every turn, as derived **by the cmd that recorded it** (`derivedBy`).
3. `{type: "event", …ActivityEvent, raw}`: every event, normalised **by the cmd that exported it**, with the raw payload.

Because events carry their raw payloads, turns can be re-derived with the current code (replay `raw` through `normalize` and `ActivityReducer`, as `test/activity.test.ts` does with fixtures). Compare re-derived turns with the exported ones whenever the rules changed in between.

A starting point for loading it:

```ts
// node --no-warnings review.ts ~/src/agent-activity-export.jsonl
import fs from "node:fs";
const lines = fs.readFileSync(process.argv[2]!, "utf8").trim().split("\n").map((l) => JSON.parse(l));
const [header, ...rest] = lines;
const turns = rest.filter((l) => l.type === "turn");
const events = rest.filter((l) => l.type === "event");
console.log(header, turns.length, "turns", events.length, "events");
```

Keep review scripts outside the repo, or in a scratch folder; check in only what becomes a test or a fixture.

## 3. Questions to answer

Each with what to look at and what would count as a problem. Write the numbers down (step 5).

**Coverage and provenance**
- Per agent and `agentVersion`: which event kinds arrive, which fields are present (`cmd agents coverage --days 30` gives the shape). Unmapped event names (`kind: "other"`)? New ones mean an adapter row to add.
- Are `agentVersion` and `recorded.cmd` set on every hook event? Missing versions mean the executable-path heuristic (`agentVersion` in `procinfo.ts`) misses an install method.
- Interactive Claude: does SessionStart carry `model` (it doesn't in `-p` runs)?

**State**
- Agents whose last state is `working` with no events for a long time (stuck states). Find them via turns with `outcome: "working"` and an old `startedAt`.
- `stateCause` distribution: how much is `hook …` vs `inferred: …`.
- Every deliberate case from step 1: did the agent's state do the right thing at that time? (Look up events around the noted time.)

**Interrupts (the riskiest rule)**
- Turns ended `interrupted` with `inferred: ["quiet for 30 s …"]`: for each, was it a real interrupt? A wrong one shows as a turn that reopens (`inferred` lost its quiet entry, later events in the same turn) or as a quiet period while the agent was really thinking.
- Real Esc presses (from the notes): were they caught, and how long after? If Claude sends something on Esc that we ignore (look at raw events right after the press), map it and drop the timer for that case.
- Decide: keep 30 s / 5 min, change them, or make them per agent.

**Turns**
- Turns with `prompt: null` ("began before cmd saw its prompt"): expected only after core restarts. More means events are lost or claimed late.
- `auto: true` turns (task notifications): is the pattern list in `normalize.ts` (`AUTO_PROMPT`) complete? Look for prompts starting with `<` that aren't marked.
- `background` on done turns, and whether a later auto turn always follows.
- "N tool calls never finished": real denials/failures, or calls whose PostToolUse we failed to match (different `tool_use_id` shapes)?

**Files**
- Per turn: files by `via` (`tool`, `git`, `fs`, combinations). How often is a file `git`-only (shell edits), `tool`-only (outside a repository, or git missed it), `fs`?
- Two agents in one repository: how often does a turn list files the other agent changed? (Same path in overlapping turns of different agents, `via: ["git"]` only.) If it's common, attribution needs tool paths first in the UI.
- `shellWrites > 0` with no `git`/`fs` files: either writes outside the work tree or a wrong label. Sample the commands.
- Noise: generated files that still show up (extend `IGNORE` in `fswatch.ts`).
- Cost: git snapshot time on the largest repositories used (add timing to a local build if needed; the snapshot has a 5 s timeout and 5000-file cap).

**Anomalies**
- Every `anomaly` event: what was it? Kind mismatches in particular (a hook from agent X in a pane where cmd detected Y) point at detection problems.

**Size**
- Events per day, bytes per event (`length(doc)` in SQLite), largest payloads. Decide whether 14 days and 4 KB strings are right.

## 4. Turn findings into fixes

- **Adapter fixes** go into the tables in `normalize.ts` (event names, field names, `AUTO_PROMPT`, `SHELL_WRITES`, `WRITERS`) or the rules in `reduce.ts`. Each fix gets a test.
- **Fixtures**: cut the session that showed the problem down to the events that matter and record it: `cmd agents record <agent> <file>` (rewrites the work dir to `/work/repo` and the home to `/Users/me`, and writes a header with the agent's version), into `packages/core/test/fixtures/agents/<agent>-<version>/<scenario>.jsonl`. Read it before committing: prompts and tool payloads are real text. Shorten or replace anything private; keep the shapes.
- **Rule changes** that alter turns raise `TURN_FORMAT`; changes to stored rows follow the rules in [18-agent-activity.md](18-agent-activity.md) ("Formats and versions": additive changes need no bump).
- **What the UI can rely on**: end the review with a short list of fields that are trustworthy enough to show (likely: state, final message, ask, tool-path files) and those that need a caveat or more work (inferred interrupts, git-only files with several agents, Codex failures).

## 5. Write it down

Add a dated "Findings" section to this doc with the numbers from step 3, the fixes made, and the decision on the UI. Update [18-agent-activity.md](18-agent-activity.md) where the design changed (its "Open" list in particular). Then the next steps are the features in 18's "What this enables".

## Known open points going in

From [18-agent-activity.md](18-agent-activity.md), to confirm or close with real data:

- Interrupt timing (30 s quiet, 5 min with a tool in flight) is untested on real Esc presses.
- Codex shell failures are invisible in its hooks (no exit code); its transcript has them.
- Codex interactive sessions (approvals, Esc) and Gemini aren't recorded at all yet.
- Attribution with several agents in one repository is per folder.
- The spool grows without bound while the core is down.

## Findings

### 2026-10-05, first look (6.5 hours, cmd 0.11.0)

490 events, 8 sessions, 29 turns, all Claude Code 2.1.289 (no Codex yet). No anomalies, no inferred interrupts.

- **Prompts typed while an agent works are common and steer the same turn.** 13 of 29 turns stayed `working`: in most, the next UserPromptSubmit arrived seconds after a tool call, sometimes with one still running, and the agent went on and finished with one Stop. The 0.11.0 rule ended the turn as `interrupted` there. Fixed in `TURN_FORMAT` 2: a prompt during an open turn is a follow-up (`AgentTurn.followUps`); only a new session, the quiet rule or Claude's idle prompt end an unanswered turn. An Esc followed by a new prompt within 30 s now merges into one turn too; whether that matters is for the full review.
- **A turn ended by the event that started the next one wasn't saved in its final state** (the database kept it as `working`). Fixed.
- **Claude runs helper agents after a Stop without a SubagentStart** (`agent_type` empty), about 2 s later, on most turns. Their text is a suggested next prompt or a recap of the session. They were ignored; now they're kept as `AgentTurn.notes` and don't count as subagents. A recap Claude writes anyway is a free summary for notifications.
- **A failed request's text** is what the user saw ("You've hit your weekly limit · resets …"), the code is in `error` ("rate_limit"). Turns now show the message.
- **SessionStart has no config dir** for sessions in the default `~/.claude` (no variable set): expected; coverage counts it as missing.
- Fixtures cut from these sessions, text replaced: `claude-2.1.289/interactive-followups`, `helper-note`, `rate-limit`.

Turns recorded by 0.11.0 keep `format: 1`; their raw events re-derive under format 2.
