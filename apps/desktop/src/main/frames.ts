// Pages for windows that run code the app's page must not: each is served on its
// own scheme at <scheme>://frame/, loaded in a sandboxed iframe (opaque origin,
// no preload, no window.cmd) under a CSP header that allows eval but nothing
// beyond what that page needs. The libraries are bundled into main as text and
// loaded on the first request.
//
// - cmd-visualizer: Visualizer windows (visualizer/frame.js). MilkDrop presets
//   are code that butterchurn compiles at runtime. No network.
// - cmd-livecode: Jam windows (livecode/frame.js). Strudel evaluates the
//   window's code and plays it; its audio worklets load from data: URLs and its
//   samples from Strudel's sample maps on GitHub, the only network it gets.

import visualizerJs from "../visualizer/frame.js?raw";
import livecodeJs from "../livecode/frame.js?raw";
import sampleMaps from "../livecode/sample-maps.json" with { type: "json" };

interface FramePage {
  csp: string;
  style: string;
  /** Scripts the page loads before its own, served at /<name>. */
  libs: Record<string, () => Promise<{ default: string }>>;
  script: string;
}

/**
 * Where a Jam frame may fetch samples from: the origins of its sample maps
 * (livecode/sample-maps.json) and of the samples they list, all on GitHub today.
 */
const SAMPLE_ORIGINS = [...new Set(sampleMaps.maps.map((m) => new URL(m.url).origin))].join(" ");

const PAGES: Record<string, FramePage> = {
  "cmd-visualizer": {
    csp: "default-src 'none'; script-src cmd-visualizer: 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:",
    style: "html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100%;height:100%}",
    libs: {
      "butterchurn.js": () => import("butterchurn/lib/butterchurn.min.js?raw"),
      "presets.js": () => import("butterchurn-presets/lib/butterchurnPresets.min.js?raw"),
    },
    script: visualizerJs,
  },
  "cmd-livecode": {
    csp: `default-src 'none'; script-src cmd-livecode: data: 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; connect-src ${SAMPLE_ORIGINS}; media-src ${SAMPLE_ORIGINS} data: blob:`,
    style: "html,body{margin:0}",
    libs: { "strudel.js": () => import("@strudel/web/dist/index.js?raw") },
    script: `window.SAMPLE_MAPS = ${JSON.stringify(sampleMaps.maps)};\n${livecodeJs}`,
  },
};

export const FRAME_SCHEMES = Object.keys(PAGES);

/** A frame page's own URL: the only place its iframe may navigate (main/index.ts). */
export const isFramePage = (url: string): boolean => FRAME_SCHEMES.some((s) => url === `${s}://frame/`);

/** A request from one of these pages (they may not ask for permissions or capture). */
export const fromFrame = (url: string | undefined): boolean => FRAME_SCHEMES.some((s) => (url ?? "").startsWith(`${s}:`));

export function frameHandler(scheme: string): (req: Request) => Promise<Response> {
  const page = PAGES[scheme]!;
  const html = `<!doctype html><html><head><meta charset="utf-8"><style>${page.style}</style>
${Object.keys(page.libs).map((n) => `<script src="${n}"></script>`).join("")}</head>
<body><script>${page.script}</script></body></html>`;
  const headers = (type: string) => ({ "content-type": type, "content-security-policy": page.csp });
  return async (req) => {
    const { host, pathname } = new URL(req.url);
    if (host !== "frame") return new Response("not found", { status: 404 });
    if (pathname === "/") return new Response(html, { headers: headers("text/html; charset=utf-8") });
    const lib = page.libs[pathname.slice(1)];
    if (!lib) return new Response("not found", { status: 404 });
    return new Response((await lib()).default, { headers: { ...headers("text/javascript; charset=utf-8"), "cache-control": "max-age=31536000, immutable" } });
  };
}
