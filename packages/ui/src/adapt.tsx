// A layout per size (docs/57, A1): Adapt measures its own box and draws the first Case whose
// conditions it meets, so a window (or a pane: the box is the Adapt's, not the window's) can
// have a compact, a regular and a large face, switched at the numbers the layout breaks at.
// Hide is for one thing that gives way in a narrow window; Adapt for a different face. The
// switch is a remount, not an animation: the case's own pieces keep no state across it.

import { Children, isValidElement, useLayoutEffect, useRef, useState, type ReactElement, type ReactNode } from "react";

/** A Case's conditions, each in px and inclusive; none given: it always fits. */
export interface CaseConditions {
  minWidth?: number;
  maxWidth?: number;
  minHeight?: number;
  maxHeight?: number;
}

/** Whether a box meets every condition given. */
export function fits(c: CaseConditions, box: { width: number; height: number }): boolean {
  const ok = (n: number | undefined, test: (n: number) => boolean) => typeof n !== "number" || test(n);
  return ok(c.minWidth, (n) => box.width >= n) && ok(c.maxWidth, (n) => box.width <= n) && ok(c.minHeight, (n) => box.height >= n) && ok(c.maxHeight, (n) => box.height <= n);
}

/** The first case that fits the box, by index; -1 when none does. */
export const pickCase = (cases: readonly CaseConditions[], box: { width: number; height: number }): number => cases.findIndex((c) => fits(c, box));

/**
 * One layout of an `Adapt`, drawn while the Adapt's box meets every condition given (px,
 * inclusive); without conditions it always fits (the fallback, last). Outside an Adapt it is
 * just its children.
 */
export function Case({ children }: CaseConditions & { children?: ReactNode }) {
  return <>{children}</>;
}

/**
 * A layout per size: draws the first `Case` child whose conditions its own box meets,
 * measured with a ResizeObserver (a Pane's width in a Pane, the view's body directly in a
 * View), and switches as it resizes. Order the cases from the most demanding to a fallback
 * without conditions. It fills the room it is given (a View's body, a growing Stack), so a
 * height condition reads the room, not the case's content. The case drawn is keyed by its
 * place: a switch mounts the new case afresh.
 */
export function Adapt({ children }: { children: ReactNode }) {
  const cases = Children.toArray(children).filter((c): c is ReactElement<CaseConditions & { children?: ReactNode }> => isValidElement(c));
  const conditions = cases.map((c) => c.props);
  const latest = useRef(conditions);
  latest.current = conditions;
  const ref = useRef<HTMLDivElement>(null);
  const box = useRef<{ width: number; height: number } | null>(null);
  const [picked, setPicked] = useState(-2);
  useLayoutEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => {
      box.current = { width: el.clientWidth, height: el.clientHeight };
      setPicked(pickCase(latest.current, box.current));
    };
    measure();
    if (typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  // New cases (a patch) are judged against the last box, without waiting for a resize.
  const index = box.current ? pickCase(conditions, box.current) : picked;
  return (
    <div ref={ref} className="ui-adapt" data-case={index >= 0 ? index : undefined}>
      {index >= 0 && <div key={index} className="ui-adapt-case">{cases[index]}</div>}
    </div>
  );
}
