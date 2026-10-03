// Entry point of the Magic tools' MCP relay (mcp.ts), started by CLI backends
// such as `claude -p` (backends.ts). Lives in the core so the app needs no CLI.

import { serveMcp } from "./mcp.ts";

await serveMcp();
