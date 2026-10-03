// Per-window actions that app commands route to (e.g. ⌘S → the focused text
// window's save). Windows register on mount.

type Actions = { save?: () => void | Promise<void> };
const registry = new Map<string, Actions>();

export function registerWindowActions(id: string, actions: Actions): () => void {
  registry.set(id, actions);
  return () => {
    if (registry.get(id) === actions) registry.delete(id);
  };
}

export function windowActions(id: string | null): Actions | undefined {
  return id ? registry.get(id) : undefined;
}
