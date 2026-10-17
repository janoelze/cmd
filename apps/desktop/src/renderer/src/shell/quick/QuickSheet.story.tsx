// The Quick Command sheet (docs/58), with the core's quick.resolve done here: what a command
// asks for, what it will run with those values, and Run.
import { fillQuick, parseQuick, quickMode, type QuickCommand, type QuickContext, type QuickResolved } from "@cmd/protocol";
import { QuickSheet } from "./QuickSheet.tsx";

const noop = () => {};
const vars = { folder: "/Users/you/src/app", workspace: "/Users/you/src/app", branch: "main", date: "2026-10-17" };

function sheet(command: QuickCommand, context: QuickContext = { paneId: "p1" }, intoAgent = false) {
  const resolve = async (values: Record<string, string>): Promise<QuickResolved> => {
    const p = parseQuick(command.body);
    const mode = quickMode(command.target ?? "type", command.body, intoAgent);
    return { ...fillQuick(p, mode, { ...vars, file: context.file }, values), asks: p.asks, mode };
  };
  const pending = { command, context, resolved: { text: null, missing: [], asks: parseQuick(command.body).asks, mode: "shell" as const } };
  return <QuickSheet pending={pending} onClose={noop} resolve={resolve} run={async () => {}} />;
}

/** A text field and a choice, the command under them with the values quoted. */
export const Asks = () => sheet({ id: "logs", name: "Service Logs", description: "Follow a service's logs", body: "docker compose logs -f {{ask:service=api}} --since {{pick:since=10m,1h,1d}}", target: "terminal" });
/** Nothing to fill in: it asks before it runs. */
export const Confirm = () => sheet({ id: "deploy", name: "Deploy Staging", body: "git push staging {{branch}}:main --force-with-lease", confirm: true });
/** Typed to the agent in the terminal: values as they are. */
export const ToAgent = () => sheet({ id: "review", name: "Review File", body: "Review {{file}} for missing tests, focusing on {{ask:focus=error paths}}." }, { paneId: "p1", file: "/Users/you/src/app/src/auth.ts" }, true);
/** A file it needs isn't selected. */
export const Missing = () => sheet({ id: "cat", name: "Show File", body: "bat {{file}}", target: "terminal" }, {});
