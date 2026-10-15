// What the element table's entries share (elements.tsx, entries-1.2.tsx): the context an
// element is drawn in, a prop read as the kit's type, a handler prop as a function that sends
// its interaction, and a typed text kept here while the process gets it debounced.

import { useEffect, useRef, useState, type ReactNode } from "react";
import { isHandler, type TreeElement, type WireValue, type WindowId } from "@cmd/protocol";
import type { Send } from "./chrome.ts";

/** What every element is drawn with: its window and the way back to its process. */
export interface DrawContext {
  windowId: WindowId;
  send: Send;
}

/** An entry's input: the element's (sanitised) props, its children drawn, and the node. */
export interface Drawn {
  p: Record<string, WireValue>;
  children: ReactNode;
  node: TreeElement;
  ctx: DrawContext;
}

/** A prop as the kit's type (the sanitiser checked it against API_ELEMENTS). */
export const v = <T,>(x: WireValue | undefined): T | undefined => (x === null || x === undefined ? undefined : (x as T));
export const str = (x: WireValue | undefined) => (typeof x === "string" ? x : undefined);

/** A handler prop as a function sending its interaction; undefined without one. */
export function on(ctx: DrawContext, ref: WireValue | undefined, event: string): ((value?: WireValue) => void) | undefined {
  return isHandler(ref) ? (value?: WireValue) => ctx.send(ref.$handler, event, value) : undefined;
}
/** The same, for the kit's handlers that pass a DOM event: none of it crosses. */
export function press(ctx: DrawContext, ref: WireValue | undefined, event: string): (() => void) | undefined {
  const fn = on(ctx, ref, event);
  return fn && (() => fn());
}

/** A text the person types into: the caret stays here, the value goes to the process debounced (docs/56). */
export const DEBOUNCE_MS = 150;
export function useDraft(value: string, send: ((v: string) => void) | undefined): [string, (v: string) => void, () => string] {
  const [draft, setDraft] = useState(value);
  const sent = useRef(value);
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const latest = useRef(value);
  // The tree's value wins when it changes to something this field didn't send (the widget cleared it).
  useEffect(() => {
    if (value !== sent.current) {
      sent.current = value;
      latest.current = value;
      setDraft(value);
    }
  }, [value]);
  useEffect(() => () => clearTimeout(timer.current), []);
  const flush = () => {
    clearTimeout(timer.current);
    if (latest.current !== sent.current) {
      sent.current = latest.current;
      send?.(latest.current);
    }
    return latest.current;
  };
  const change = (next: string) => {
    latest.current = next;
    setDraft(next);
    clearTimeout(timer.current);
    timer.current = setTimeout(flush, DEBOUNCE_MS);
  };
  return [draft, change, flush];
}

