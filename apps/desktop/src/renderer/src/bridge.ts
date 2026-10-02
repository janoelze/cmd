import type { CmdBridge } from "../../preload/index.ts";

declare global {
  interface Window {
    cmd: CmdBridge;
  }
}

export const cmd = window.cmd;
