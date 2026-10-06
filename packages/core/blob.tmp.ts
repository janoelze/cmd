import { DataStore } from "./src/data/store.ts";
const s = new DataStore(process.argv[2]!);
for (const e of s.query({ types: ["agent.output"], agentId: process.argv[3] })) console.log(`--- ${e.text}\n${e.blob ? s.blob(e.blob)!.toString() : "(inline) " + JSON.stringify(e.data)}`);
