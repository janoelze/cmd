// Scratch: describe a folder with the release app's key (read in place) and write the cache row into a CMD_HOME's database.
import { DatabaseSync } from "node:sqlite";
import { SecretsService } from "./src/secrets.ts";
import { AiService } from "./src/ai/service.ts";
import { DEFAULT_SETTINGS } from "@cmd/protocol";
import { scan } from "./src/actions/catalog.ts";
import { describe, inputOf, DescribedCache } from "./src/actions/describe.ts";
const [root, dbFile] = process.argv.slice(2);
const ai = new AiService({ settings: () => DEFAULT_SETTINGS as never, secrets: new SecretsService(process.env.HOME + "/Library/Application Support/cmd/secrets.json"), stateDir: null });
ai.start();
await new Promise((r) => setTimeout(r, 2000));
const actions = scan(root!, null).actions;
const input = inputOf(root!, actions);
const d = await describe(ai, root!, actions, input);
new DescribedCache(new DatabaseSync(dbFile!)).set(root!, input.hash, d);
console.log("seeded", Object.keys(d.actions).length, "primary", d.primary);
process.exit(0);
