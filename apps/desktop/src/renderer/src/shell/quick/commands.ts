// Session → Quick Commands' own commands (docs/58): adding and editing them, in Settings. The
// person's Quick Commands themselves aren't app commands: they run through quick.ts.

import { cmd } from "../../lib/bridge.ts";
import { registerCommands } from "../commands/registry.ts";

registerCommands({
  "session.newQuickCommand": { run: () => cmd.openSettings("quick/new") },
  "session.quickCommands": { run: () => cmd.openSettings("quick") },
});
