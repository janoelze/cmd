// Relay entry point. Env: PORT (8787), HOST (127.0.0.1; 0.0.0.0 on Uberspace),
// RELAY_ORIGIN (the web client's origin), RELAY_STATE (routes file),
// RELAY_TRUST_PROXY=1 behind a frontend that sets X-Forwarded-For.

import { startRelay } from "./relay.ts";

const relay = await startRelay({
  port: Number(process.env.PORT ?? 8787),
  host: process.env.HOST ?? "127.0.0.1",
  origin: process.env.RELAY_ORIGIN || null,
  stateFile: process.env.RELAY_STATE || null,
  trustProxy: process.env.RELAY_TRUST_PROXY === "1",
});
console.log(`[relay] listening on ${relay.url}`);
for (const sig of ["SIGINT", "SIGTERM"] as const) process.on(sig, () => void relay.close().then(() => process.exit(0)));
