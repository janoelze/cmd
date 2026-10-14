// The one frame host (AR1-11-05): how the app talks to a page in a sandboxed iframe (a frame
// widget's view.html, the Visualizer's presets, Jam's player). Such a page is an opaque origin
// ("null"), so a message is taken only from the iframe's own window; a press or right-click it
// reports selects its window or opens its menu (embed.ts); the rest goes to the view's handler.
//
// What a page asks on the person's behalf (`actions`: opening a link) is checked here, on the
// trusted side, never left to the page: it counts only right after a press in the frame (the
// Gesture below), at most once a second, and once per press.

import { useEffect, useLayoutEffect, useRef, type RefObject } from "react";
import { handleEmbedMessage } from "./embed.ts";

/** A message from a frame: an object with a `type`. */
export type FrameMessage = { type: string } & Record<string, unknown>;

export interface FrameOptions {
  /** Messages that act for the person, by type: run only after a press in the frame (Gesture). */
  actions?: Record<string, (m: FrameMessage) => void>;
  /** The frame's window is the selected one: a press into a window that isn't only selects it. */
  active?: boolean;
}

/** The least time between two actions of one frame (ms). */
export const ACTION_EVERY_MS = 1000;

export interface GestureEnv {
  now(): number;
  /** The iframe holds the focus (a click or Tab put it there). */
  focused(): boolean;
  /** The page has a transient user activation (a click or key press, here or in a frame within the last seconds). */
  activated(): boolean;
  /** The frame's window is selected. */
  active(): boolean;
  /** Take the focus back from the iframe, so the next press into it is seen. */
  release(): void;
}

/**
 * Whether a press in a cross-origin frame came before an action. The app can't see the
 * pointer in the frame, but it sees the focus arrive there (focusIn: the iframe becomes the
 * focused element as the press lands) and that the page has a user activation, which only
 * real input gives, and which a frame's press passes up to the app's page. A focus-in counts
 * when the window was already selected; an action spends it, and the focus is taken back so
 * the next press is a new focus-in. A page that only claims a press (its own postMessage)
 * gets nothing: there was no focus-in, or no activation.
 */
export class Gesture {
  #env: GestureEnv;
  #armed = false;
  #last = -Infinity;
  constructor(env: GestureEnv) {
    this.#env = env;
  }
  /** The focus went into the frame (called again a moment later, for an activation that comes after it). */
  focusIn(wasActive = this.#env.active()): void {
    if (wasActive && this.#env.active() && this.#env.activated()) this.#armed = true;
  }
  /** The window became selected (or not): a frame still holding the selecting press's focus gives it back. */
  activeChanged(active: boolean): void {
    if (active && !this.#armed && this.#env.focused()) this.#env.release();
    if (!active) this.#armed = false;
  }
  /** May an action run now? Spends the press when it may. */
  take(): boolean {
    const now = this.#env.now();
    if (!this.#armed || !this.#env.focused() || !this.#env.activated() || !this.#env.active() || now - this.#last < ACTION_EVERY_MS) return false;
    this.#armed = false;
    this.#last = now;
    this.#env.release();
    return true;
  }
}

/**
 * Host a sandboxed iframe: `onMessage` gets each message of its own page (not presses or
 * right-clicks, which select its window or open its menu, nor `actions`, which run only after a
 * press in it). Returns `post`, which sends the page a message (with transferables).
 */
export function useFrame(ref: RefObject<HTMLIFrameElement | null>, onMessage: (m: FrameMessage) => void, o: FrameOptions = {}): (m: unknown, transfer?: Transferable[]) => void {
  const latest = useRef({ onMessage, o });
  latest.current = { onMessage, o };
  const gesture = useRef<Gesture | null>(null);
  gesture.current ??= new Gesture({
    now: () => Date.now(),
    focused: () => !!ref.current && document.activeElement === ref.current,
    activated: () => navigator.userActivation?.isActive ?? false,
    active: () => latest.current.o.active !== false,
    release: () => {
      const el = ref.current;
      if (el && document.activeElement === el) el.blur();
    },
  });

  // Before paint, so a fast page's "ready" can't arrive before anyone listens.
  useLayoutEffect(() => {
    const onWindowMessage = (e: MessageEvent) => {
      const el = ref.current;
      if (!el || e.source !== el.contentWindow || !e.data || typeof e.data !== "object" || typeof (e.data as { type?: unknown }).type !== "string") return;
      const m = e.data as FrameMessage;
      if (handleEmbedMessage(el, m)) return;
      const action = latest.current.o.actions?.[m.type];
      if (action) return void (gesture.current!.take() ? action(m) : console.debug(`frame: ${m.type} without a press in the frame, ignored`));
      latest.current.onMessage(m);
    };
    // The focus arriving in the frame (the app's window gets `blur`, the iframe `focusin`). The
    // frame's activation reaches this page through another process: if it isn't here yet, look again.
    let retry = 0;
    const onFocusIn = () =>
      queueMicrotask(() => {
        if (!ref.current || document.activeElement !== ref.current) return;
        const wasActive = latest.current.o.active !== false;
        gesture.current!.focusIn(wasActive);
        clearTimeout(retry);
        retry = window.setTimeout(() => document.activeElement === ref.current && gesture.current!.focusIn(wasActive), 100);
      });
    window.addEventListener("message", onWindowMessage);
    window.addEventListener("blur", onFocusIn);
    document.addEventListener("focusin", onFocusIn, true);
    return () => {
      clearTimeout(retry);
      window.removeEventListener("message", onWindowMessage);
      window.removeEventListener("blur", onFocusIn);
      document.removeEventListener("focusin", onFocusIn, true);
    };
  }, [ref]);

  const active = o.active !== false;
  useEffect(() => gesture.current!.activeChanged(active), [active]);

  return (m, transfer) => ref.current?.contentWindow?.postMessage(m, "*", transfer ?? []);
}
