// The Operator (docs/51-operator.md): an agent in a widget that runs the workspace through
// cmd's own methods while you watch. One conversation per workspace, owned by the core: what
// it says, the tools it calls (each with the window it acts on and a line on why), and the
// approvals it waits for. The widget and the board's marks draw from operator.changed.

import type { WindowId, WorkspaceId } from "./model.ts";

/** What the widget, the library and the palette call it; one place to rename. */
export const OPERATOR_TITLE = "Operator";

/** A tool call's state, as the card shows it: waiting is for your approval. */
export type OperatorToolState = "running" | "waiting" | "done" | "failed" | "denied";

export type OperatorItem =
  | { kind: "user"; id: string; at: number; text: string }
  /** What the Operator says; it grows while it streams. */
  | { kind: "text"; id: string; at: number; text: string }
  | {
      kind: "tool";
      id: string;
      at: number;
      /** The tool's name ("run", "look"). */
      tool: string;
      /** One line for people: what this step does ("Running the tests"). */
      why: string;
      /** Whether it changes something (marked on the board) or only looks. */
      acts: boolean;
      /** The window it acts on or reads, when there is one. */
      target: WindowId | null;
      state: OperatorToolState;
      input: Record<string, unknown>;
      /** What it asks you to allow, in words ("Type in the terminal “tests”"). */
      ask?: string;
      /** Exactly what would happen: the text to type, a file's diff. */
      exact?: string;
      /** What "Always allow" would remember for this workspace ("commands starting “pnpm test”"). */
      offer?: string;
      /** It ran without asking: the person allows this here (the remembered approval's label). */
      remembered?: string;
      /** The result as the model got it, or why it failed or was denied. */
      output?: string;
      ms?: number;
    }
  | { kind: "error"; id: string; at: number; text: string }
  /** News the Operator was told without being asked: an agent it started is done, failed or needs input. */
  | { kind: "event"; id: string; at: number; text: string };

export interface OperatorUsage {
  input: number;
  output: number;
  cacheRead: number;
}

export interface OperatorConversation {
  workspaceId: WorkspaceId;
  /** 1–3 nouns for what it is about (docs/32's namer), once its first turn ended; null until then. */
  name: string | null;
  items: OperatorItem[];
  /** A turn is running (thinking, calling tools or waiting for you). */
  busy: boolean;
  usage: OperatorUsage;
  model: string | null;
  /** The last turn's timing: until its first tool started, and in all (docs/51, latency). */
  latency: { firstStepMs: number | null; totalMs: number } | null;
}

/** A conversation put away by New Conversation, to open again. */
export interface OperatorPast {
  id: string;
  /** Its name, else its first request. */
  title: string;
  /** When it was last added to. */
  at: number;
  /** Requests in it. */
  requests: number;
}

/** The Operator's conversation in a workspace changed: items added or updated (by id), or its state. Part of CoreEvent (rpc.ts). */
export type OperatorEvent = {
  type: "operator.changed";
  workspaceId: WorkspaceId;
  /** New or changed items, in order; replace those with the same id. */
  items?: OperatorItem[];
  /** The whole conversation was cleared (operator.reset). */
  reset?: boolean;
  name?: string | null;
  busy?: boolean;
  usage?: OperatorUsage;
  model?: string | null;
  latency?: OperatorConversation["latency"];
};

/** The Operator's RPC methods, part of `Methods` (rpc.ts). */
export interface OperatorMethods {
  /** The workspace's conversation with the Operator; changes arrive as operator.changed. */
  "operator.get": { params: { workspaceId: WorkspaceId }; result: OperatorConversation };
  /**
   * Ask the Operator something in a workspace. Starts a turn, or joins the running one (the
   * message goes in with its next tool results). `selected`: the window the person means by "this".
   */
  "operator.send": { params: { workspaceId: WorkspaceId; text: string; selected?: WindowId | null }; result: null };
  /** Stop the running turn: the model call and the tools it runs. */
  "operator.stop": { params: { workspaceId: WorkspaceId }; result: null };
  /** Start a new conversation: the current one is put away (operator.history), a running turn stopped first. */
  "operator.reset": { params: { workspaceId: WorkspaceId }; result: null };
  /** The workspace's past conversations, newest first. */
  "operator.history": { params: { workspaceId: WorkspaceId }; result: OperatorPast[] };
  /** Go back to a past conversation: the current one is put away in its place. */
  "operator.open": { params: { workspaceId: WorkspaceId; id: string }; result: null };
}
