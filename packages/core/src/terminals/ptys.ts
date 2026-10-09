// Why a shell couldn't be spawned, when the system can tell. node-pty only says
// "posix_spawnp failed"; opening /dev/ptmx allocates a pseudo-terminal, so when
// that fails for want of one, the Mac is out of them (kern.tty.ptmx_max, 511).

import fs from "node:fs";

/** Whether no pseudo-terminal is left for a new shell. */
export function ptysExhausted(): boolean {
  if (process.platform === "win32") return false;
  try {
    fs.closeSync(fs.openSync("/dev/ptmx", "r+"));
    return false;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENXIO" || code === "EAGAIN" || code === "ENOSPC";
  }
}
