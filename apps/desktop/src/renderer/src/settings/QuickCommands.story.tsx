// Settings → Quick Commands' editor (docs/58), for a new command and an existing one. Saving does nothing here.
import type { Workspace } from "@cmd/protocol";
import { QuickEditor } from "./QuickCommands.tsx";

const noop = () => {};
const done = async () => {};
const taken = { "file.newTerminal": ["Cmd+T"] };
const ws = (name: string, root: string) => ({ id: name, name, root, home: false, icon: null, order: 0, closedAt: null }) as unknown as Workspace;
const workspaces = [ws("cmd", "/Users/me/src/cmd"), ws("site", "/Users/me/src/site")];

/** Empty, as Session → New Quick Command… opens it. */
export const New = () => <QuickEditor command={null} others={[]} taken={taken} onClose={noop} onSave={done} onDelete={done} />;
/** One with a shortcut that asks first, kept to one workspace. */
export const Edit = () => (
  <QuickEditor
    command={{ id: "push", name: "Push Branch", description: "Push and set upstream", body: "git push -u origin {{branch}}", keys: ["Ctrl+Alt+P"], confirm: true, workspace: "/Users/me/src/cmd" }}
    others={[]}
    workspaces={workspaces}
    taken={taken}
    onClose={noop}
    onSave={done}
    onDelete={done}
  />
);
/** A misspelt variable, said under the command. */
export const Mistake = () => <QuickEditor command={{ id: "x", name: "Show File", body: "bat {{fiel}}", target: "terminal" }} others={[]} taken={taken} onClose={noop} onSave={done} onDelete={done} />;
