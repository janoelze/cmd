// Removing a test's temp folder. Windows keeps a folder busy while anything in
// it is open, including a terminal still exiting with it as its cwd: retry,
// then leave it there rather than fail the run (the OS cleans its temp).
import fs from "node:fs";

export function rmTemp(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true, maxRetries: 10, retryDelay: 100 });
  } catch (e) {
    if (process.platform !== "win32") throw e;
  }
}
