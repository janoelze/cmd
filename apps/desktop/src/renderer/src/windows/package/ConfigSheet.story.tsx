// A package widget's Configure sheet (ConfigSheet.tsx, docs/56), with a stand-in for the core:
// a CI widget's fields of every type, first with nothing set, then configured with its token set.
import type { WidgetConfigField, WidgetEntry } from "@cmd/protocol";
import { ConfigSheet, type ConfigApi } from "./ConfigSheet.tsx";

const noop = () => {};
const FIELDS: WidgetConfigField[] = [
  { key: "repo", title: "Repository", type: "string", description: "owner/name on GitHub" },
  { key: "limit", title: "Runs", type: "number", default: 10 },
  { key: "failedOnly", title: "Only failures", type: "boolean", default: false },
  { key: "branch", title: "Branch", type: "enum", options: ["main", "dev"], default: "main" },
  { key: "token", title: "Token", type: "string", secret: true, host: "api.github.com", description: "A token that can read Actions" },
];
const entry = (secrets: string[]): WidgetEntry & { config: WidgetConfigField[] } => ({ ref: "pkg:ci/ci", source: "package", kind: "pkg:ci/ci", title: "CI", icon: "checkmark.seal", windows: [], config: FIELDS, secrets });
const api = (set: string[]): ConfigApi => ({ config: async () => null, secret: async () => null, secrets: async () => set });

export const NotSet = () => <ConfigSheet entry={entry([])} config={undefined} onClose={noop} api={api([])} />;
export const Configured = () => <ConfigSheet entry={entry(["token"])} config={{ repo: "jan/cmd", limit: 25, failedOnly: true }} onClose={noop} api={api(["token"])} />;
