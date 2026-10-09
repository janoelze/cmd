// Visualizer, a built-in widget: MilkDrop presets (butterchurn) moving to a
// source of sound. Its state is the window's (core windows/builtin.ts
// visualizerType: preset, source, cycle). The presets run in a sandboxed frame
// (main/visualizer.ts, visualizer/frame.js), since they are code; this view
// taps the source (audio.ts) and posts its samples into the frame every frame.
// The title bar shows the preset; its menu picks the source and the preset.

import { useEffect, useRef } from "react";
import type { AppWindow } from "@cmd/protocol";
import { audioContext, publishedSources, tap } from "../audio.ts";
import type { MenuEntry } from "../context.ts";
import { handleEmbedMessage } from "../embed.ts";
import { setWidgetState } from "../widgets.ts";
import { setWindowStatus } from "../windowActions.ts";
import type { WindowViewProps } from "../windows/registry.ts";
import "./widgets.css";

/** The pack's preset names, once a frame has said them (the same in every frame). */
let presetNames: string[] = [];

/** What the menu asks of a window's frame. */
const controls = new Map<string, { next(): void; back(): void; current(): string | null }>();

export const CYCLES = [0, 15, 30, 60, 120];

const sourceOf = (w: AppWindow) => (typeof w.state.source === "string" ? w.state.source : "none");
const cycleOf = (w: AppWindow) => (typeof w.state.cycle === "number" ? w.state.cycle : 30);

/** "Microphone", "System Audio", a Jam window's name. */
export function sourceLabel(source: string): string {
  if (source === "mic") return "Microphone";
  if (source === "system") return "System Audio";
  if (source.startsWith("window:")) return publishedSources().find((s) => s.id === source)?.label ?? "Not Playing";
  return "No Sound";
}

/** Source, presets and how often they change: the title bar's menu and the right-click menu. */
export function visualizerMenu(w: AppWindow): MenuEntry[] {
  const source = sourceOf(w);
  const pick = (id: string) => () => setWidgetState(w.id, { source: id });
  const windows = publishedSources();
  const current = controls.get(w.id)?.current() ?? null;
  const cycle = cycleOf(w);
  return [
    { label: "No Sound", checked: source === "none", run: pick("none") },
    { label: "Microphone", checked: source === "mic", run: pick("mic") },
    { label: "System Audio", checked: source === "system", run: pick("system") },
    ...(windows.length || source.startsWith("window:") ? ["-" as const] : []),
    ...windows.map((s) => ({ label: s.label, checked: source === s.id, run: pick(s.id) })),
    ...(source.startsWith("window:") && !windows.some((s) => s.id === source) ? [{ label: "Not Playing", checked: true, enabled: false, run: () => {} }] : []),
    "-",
    { label: "Next Preset", run: () => controls.get(w.id)?.next() },
    { label: "Previous Preset", run: () => controls.get(w.id)?.back() },
    {
      label: "Presets",
      enabled: presetNames.length > 0,
      submenu: presetNames.map((name) => ({ label: name, checked: name === current, run: () => setWidgetState(w.id, { preset: name }) })),
    },
    {
      label: "Change Preset",
      submenu: CYCLES.map((s) => ({ label: s === 0 ? "Never" : s < 60 ? `Every ${s} s` : `Every ${s / 60} min`, checked: s === cycle, run: () => setWidgetState(w.id, { cycle: s }) })),
    },
  ];
}

export function VisualizerView({ win }: WindowViewProps) {
  const ref = useRef<HTMLIFrameElement>(null);
  const ready = useRef(false);
  const history = useRef<string[]>([]);
  const preset = typeof win.state.preset === "string" ? win.state.preset : null;
  const source = sourceOf(win);
  const cycle = cycleOf(win);
  const post = (m: unknown, transfer?: Transferable[]) => ref.current?.contentWindow?.postMessage(m, "*", transfer);

  const show = (name: string | null) => post({ type: "preset", name, blend: 2.5 });
  const random = () => {
    const now = history.current.at(-1);
    const others = presetNames.filter((n) => n !== now);
    return others[Math.floor(Math.random() * others.length)] ?? null;
  };

  // The frame's messages: only from our own frame (opaque origins all say "null").
  const presetRef = useRef(preset);
  presetRef.current = preset;
  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (e.source !== ref.current?.contentWindow || !e.data || typeof e.data !== "object") return;
      const m = e.data as { type?: string; presets?: unknown; name?: unknown; message?: unknown };
      if (m.type === "ready") {
        if (Array.isArray(m.presets)) presetNames = m.presets.filter((n): n is string => typeof n === "string");
        ready.current = true;
        post({ type: "init", sampleRate: audioContext().sampleRate });
        show(presetRef.current);
      } else if (m.type === "preset" && typeof m.name === "string") {
        if (history.current.at(-1) !== m.name) history.current = [...history.current.slice(-49), m.name];
        setWindowStatus(win.id, { label: m.name, key: "preset" });
      } else if (handleEmbedMessage(ref.current!, m)) return;
      else if (m.type === "error") console.warn(`visualizer ${win.id}:`, m.message);
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      setWindowStatus(win.id, null);
    };
  }, [win.id]);

  // A preset picked from the menu.
  useEffect(() => {
    if (ready.current && preset && preset !== history.current.at(-1)) show(preset);
  }, [preset]);

  // Next, back, and a new one every `cycle` seconds.
  useEffect(() => {
    const next = () => show(random());
    controls.set(win.id, {
      next,
      back: () => {
        if (history.current.length < 2) return;
        history.current = history.current.slice(0, -1);
        show(history.current.at(-1)!);
      },
      current: () => history.current.at(-1) ?? null,
    });
    const timer = cycle > 0 ? setInterval(next, cycle * 1000) : undefined;
    return () => {
      clearInterval(timer);
      controls.delete(win.id);
    };
  }, [win.id, cycle]);

  // The source's samples, every frame the page draws.
  useEffect(() => {
    if (source === "none") {
      const silence = new Uint8Array(1024).fill(128);
      post({ type: "audio", t: silence, l: silence, r: silence });
      return;
    }
    const t = tap(source, (err) => {
      const label = source === "mic" ? "Can't hear the microphone" : source === "system" ? "Can't hear system audio" : "Can't hear it";
      setWindowStatus(win.id, { label, key: "error" });
      console.warn(`visualizer ${win.id}:`, err.message);
    });
    let frame = requestAnimationFrame(function send() {
      if (ready.current) post({ type: "audio", ...t.read() });
      frame = requestAnimationFrame(send);
    });
    return () => {
      cancelAnimationFrame(frame);
      t.close();
    };
  }, [win.id, source]);

  return <iframe ref={ref} className="visualizer-frame" data-embed sandbox="allow-scripts" src="cmd-visualizer://frame/" title={win.title} />;
}
