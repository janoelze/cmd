import type { Method, Params, Result } from "@cmd/protocol";
import type { CmdBridge } from "../../preload/index.ts";

declare global {
  interface Window {
    cmd: CmdBridge;
  }
}

// contextBridge hands errors over as their message alone, so a failed core call reached
// crash reports with no stack and no hint of which call it was. Rethrow it with the
// method and the stack of the code that made the call.
async function call<M extends Method>(method: M, params: Params<M>): Promise<Result<M>> {
  const site = new Error();
  try {
    return await window.cmd.call(method, params);
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    const frames = site.stack?.slice(site.stack.indexOf("\n")) ?? "";
    e.stack = `${e.name}: ${e.message}\n    in core call ${method}${frames}`;
    throw e;
  }
}

export const cmd: CmdBridge = { ...window.cmd, call };
