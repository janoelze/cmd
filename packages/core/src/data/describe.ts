// What the log's entities are (docs/28 §2, "Entities and links"): agents,
// sessions, panes, windows and Spaces described from the services that own them,
// and the links between them (an agent ran in a pane and runs a session; a
// session is in a project; a window and a pane are in a Space). Written when
// they change (DataService.describe skips repeats). Projects describe themselves
// from their folder when first seen (service.ts).

import type { Agent, AppWindow, Pane, Space } from "@cmd/protocol";
import { HOME_SPACE_ID } from "@cmd/protocol";
import { sessionIdOf } from "../agents/tracker.ts";
import { projectIdOf } from "./project.ts";
import type { DataService } from "./service.ts";
import type { SessionRow } from "./views/sessions.ts";

export function describeAgent(data: DataService, a: Agent): void {
  data.describe("agent", a.id, { kind: a.kind, name: a.name, cwd: a.cwd, model: a.model ?? null, version: a.version ?? null, spaceId: a.spaceId, parentId: a.parentId, createdAt: a.createdAt });
  const at = a.createdAt;
  if (a.paneId) data.link(["agent", a.id], ["pane", a.paneId], "ran in", at);
  const sid = sessionIdOf(a);
  if (sid) data.link(["agent", a.id], ["session", `${a.kind}:${sid}`], "runs", at);
  if (a.parentId) data.link(["agent", a.id], ["agent", a.parentId], "child of", at);
  const project = projectIdOf(a.cwd);
  if (project) data.link(["agent", a.id], ["project", project], "in", at);
}

export function describeSession(data: DataService, s: SessionRow): void {
  data.describe("session", s.key, { agent: s.agent, title: s.title, firstPrompt: s.first_prompt, cwd: s.cwd, branch: s.branch, started: s.started, updated: s.updated, messages: s.messages, path: s.path });
  if (s.project_id) data.link(["session", s.key], ["project", s.project_id], "in", s.started ?? undefined);
}

export function describePane(data: DataService, p: Pane): void {
  data.describe("pane", p.id, { cwd: p.cwd, shell: p.shell, spaceId: p.spaceId, createdAt: p.createdAt });
  data.link(["pane", p.id], ["space", p.spaceId], "in", p.createdAt);
}

export function describeWindow(data: DataService, w: AppWindow): void {
  data.describe("window", w.id, { kind: w.kind, title: w.title, spaceId: w.spaceId, createdAt: w.createdAt });
  data.link(["window", w.id], ["space", w.spaceId], "in", w.createdAt);
}

export function describeSpace(data: DataService, s: Space): void {
  data.describe("space", s.id, { name: s.name, root: s.root, home: s.id === HOME_SPACE_ID });
  const project = s.id === HOME_SPACE_ID ? null : projectIdOf(s.root);
  if (project) data.link(["space", s.id], ["project", project], "on");
}
