// cmd-visualizer://frame/ — the page Visualizer windows run in (visualizer/frame.js):
// butterchurn, its preset pack and the frame's script. MilkDrop presets are code
// that butterchurn compiles at runtime, which the app's page doesn't allow
// (script-src without 'unsafe-eval'), so they run here: in a sandboxed frame
// (opaque origin, no preload, no window.cmd), under a CSP that allows eval but
// loads nothing from outside this scheme. The libraries are bundled into main as
// text and loaded on the first request.

import frameJs from "../visualizer/frame.js?raw";

export const VISUALIZER_SCHEME = "cmd-visualizer";

const CSP = "default-src 'none'; script-src cmd-visualizer: 'unsafe-inline' 'unsafe-eval'; style-src 'unsafe-inline'; img-src data: blob:";

const LIBS: Record<string, () => Promise<{ default: string }>> = {
  "/butterchurn.js": () => import("butterchurn/lib/butterchurn.min.js?raw"),
  "/presets.js": () => import("butterchurn-presets/lib/butterchurnPresets.min.js?raw"),
};

const HTML = `<!doctype html><html><head><meta charset="utf-8">
<style>html,body{margin:0;height:100%;overflow:hidden;background:#000}canvas{display:block;width:100%;height:100%}</style>
<script src="butterchurn.js"></script><script src="presets.js"></script></head>
<body><script>${frameJs}</script></body></html>`;

const headers = (type: string) => ({ "content-type": type, "content-security-policy": CSP });

export async function serveVisualizer(req: Request): Promise<Response> {
  const { host, pathname } = new URL(req.url);
  if (host !== "frame") return new Response("not found", { status: 404 });
  if (pathname === "/") return new Response(HTML, { headers: headers("text/html; charset=utf-8") });
  const lib = LIBS[pathname];
  if (!lib) return new Response("not found", { status: 404 });
  return new Response((await lib()).default, { headers: { ...headers("text/javascript; charset=utf-8"), "cache-control": "max-age=31536000, immutable" } });
}
