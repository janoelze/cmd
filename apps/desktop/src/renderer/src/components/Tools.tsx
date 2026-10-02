import { usePersisted } from "../store.ts";
import { Symbol } from "./Symbol.tsx";
import { builtinTools, type Tool } from "../tools.ts";
import { runAction } from "../actions.ts";

export function Tools() {
  return (
    <div className="tools">
      {builtinTools.map((t) => (
        <ToolPanel key={t.id} tool={t} />
      ))}
    </div>
  );
}

function ToolPanel({ tool }: { tool: Tool }) {
  // Click the header to collapse.
  const [collapsed, setCollapsed] = usePersisted<string[]>("tools.collapsed", []);
  const shaded = collapsed.includes(tool.id);
  const setShaded = (s: boolean) => setCollapsed((c) => (s ? [...c, tool.id] : c.filter((x) => x !== tool.id)));
  return (
    <section className={`panel ${shaded ? "shaded" : ""}`}>
      <header className="panel-title" onClick={() => setShaded(!shaded)}>
        <span className={`twisty ${shaded ? "" : "open"}`}>
          <Symbol name="chevron.right" size={9} />
        </span>
        <span className="panel-name">{tool.title}</span>
      </header>
      {!shaded && (
        <div className="panel-body">
          {tool.controls.map((c, i) =>
            c.type === "button" ? (
              <button key={c.id} className="btn" onClick={() => runAction(c.action)}>
                {c.label}
                {c.hint && <span className="hint">{c.hint}</span>}
              </button>
            ) : (
              <p key={i} className="note">
                {c.text}
              </p>
            ),
          )}
        </div>
      )}
    </section>
  );
}
