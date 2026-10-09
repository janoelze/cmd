// Runs before every test file. Logs and crash reports go to a temp folder, never the
// installed app's (~/Library/Logs/cmd): a test that kills a PTY host on purpose files
// a crash report, and the app would send it to #crashes and count it in usage stats.
import os from "node:os";
import path from "node:path";

process.env.CMD_LOG_DIR = path.join(os.tmpdir(), "cmd-test", "logs");
