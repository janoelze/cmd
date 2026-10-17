// Settings → Quick Commands' editor (docs/58), for a new command and an existing one. Saving does nothing here.
import { QuickEditor } from "./QuickCommands.tsx";

const noop = () => {};
const done = async () => {};
const taken = { "file.newTerminal": ["Cmd+T"] };

/** Empty, as Session → New Quick Command… opens it. */
export const New = () => <QuickEditor command={null} others={[]} taken={taken} onClose={noop} onSave={done} onDelete={done} />;
/** One with a shortcut that asks first. */
export const Edit = () => (
  <QuickEditor
    command={{ id: "push", name: "Push Branch", description: "Push and set upstream", body: "git push -u origin {{branch}}", keys: ["Ctrl+Alt+P"], confirm: true }}
    others={[]}
    taken={taken}
    onClose={noop}
    onSave={done}
    onDelete={done}
  />
);
/** A misspelt variable, said under the command. */
export const Mistake = () => <QuickEditor command={{ id: "x", name: "Show File", body: "bat {{fiel}}", target: "terminal" }} others={[]} taken={taken} onClose={noop} onSave={done} onDelete={done} />;
