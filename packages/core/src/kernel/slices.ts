// Every folder's handlers (its handlers.ts), merged into Core.handlers with the features'
// (features.ts). A method in two slices fails test/handlers.test.ts; one in none fails tsc.

import { agentHandlers } from "../agents/handlers.ts";
import { aiHandlers } from "../ai/handlers.ts";
import { dataHandlers } from "../data/handlers.ts";
import { jamHandlers } from "../jam/handlers.ts";
import { fileHandlers } from "../lib/handlers.ts";
import { notifyHandlers } from "../notifications/handlers.ts";
import { remoteHandlers } from "../remote/handlers.ts";
import { searchHandlers } from "../search/handlers.ts";
import { sqliteHandlers } from "../sqlite/handlers.ts";
import { paneHandlers } from "../terminals/handlers.ts";
import { windowHandlers } from "../windows/handlers.ts";
import { workspaceHandlers } from "../workspaces/handlers.ts";
import type { CoreContext } from "./context.ts";
import { kernelHandlers } from "./methods.ts";

export const SLICES = { kernelHandlers, paneHandlers, notifyHandlers, agentHandlers, dataHandlers, windowHandlers, workspaceHandlers, jamHandlers, aiHandlers, fileHandlers, sqliteHandlers, searchHandlers, remoteHandlers } as const;

type Intersection<T> = (T extends unknown ? (x: T) => void : never) extends (x: infer I) => void ? I : never;
type Slices = { [K in keyof typeof SLICES]: ReturnType<(typeof SLICES)[K]> }[keyof typeof SLICES];

/** Every slice's handlers, typed as the methods they cover together. */
export const sliceHandlers = (ctx: CoreContext) => Object.assign({}, ...Object.values(SLICES).map((s) => s(ctx))) as Intersection<Slices>;
