// Events recorded again (docs/56, "Acts": API 1.1's `key`): cmd records a command as it starts
// and again as it ends, under the same key, and a reader keeps only the latest. The one merge,
// used by the core's live events topic (a burst), @cmd/widget-api's useEvents and the native
// Commands view. No imports: the widget process's bundle takes this file as it is.

/**
 * `list` with `incoming` after it, an event whose key comes again kept only as its last
 * (in `incoming`'s order, at the end); events without a key are all kept. `keyOf` reads the
 * key (default: `key`).
 */
export function mergeEvents<E>(list: readonly E[], incoming: readonly E[], keyOf: (e: E) => string | null | undefined = (e) => (e as { key?: string | null }).key): E[] {
  const last = new Map<string, number>();
  incoming.forEach((e, i) => {
    const k = keyOf(e);
    if (k) last.set(k, i);
  });
  if (!last.size) return [...list, ...incoming];
  return [
    ...list.filter((e) => {
      const k = keyOf(e);
      return !k || !last.has(k);
    }),
    ...incoming.filter((e, i) => {
      const k = keyOf(e);
      return !k || last.get(k) === i;
    }),
  ];
}
