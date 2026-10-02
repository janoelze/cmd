// Native SF Symbols (rendered by the main process), tinted with currentColor
// through a CSS mask, like an AppKit template image.

import { useEffect, useState } from "react";
import { cmd } from "../bridge.ts";

const cache = new Map<string, string | null>();
const waiting = new Map<string, Promise<void>>();

function load(name: string): Promise<void> {
  if (cache.has(name)) return Promise.resolve();
  let p = waiting.get(name);
  if (!p) {
    p = cmd.sfSymbols([name]).then((r) => {
      cache.set(name, r[name] ?? null);
      waiting.delete(name);
    });
    waiting.set(name, p);
  }
  return p;
}

export function Symbol({ name, size = 14, className = "" }: { name: string; size?: number; className?: string }) {
  const [url, setUrl] = useState(cache.get(name));
  useEffect(() => {
    let live = true;
    void load(name).then(() => live && setUrl(cache.get(name)));
    return () => {
      live = false;
    };
  }, [name]);
  return (
    <span
      className={`sf ${className}`}
      aria-hidden
      style={{
        width: size,
        height: size,
        ...(url ? { WebkitMaskImage: `url(${url})`, maskImage: `url(${url})` } : { opacity: 0 }),
      }}
    />
  );
}
