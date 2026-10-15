// Pictures (API 1.3, docs/57 A5; widgets/api/picture.ts, widgets/host/pictures.ts): a data:
// src is a PNG, JPEG, WebP or GIF by its type and its bytes, at most 512 KB; an https src is
// fetched by the core within the package's net grant (per URL, a redirect only within the
// host), as net.fetch does (cmd's user agent, no cookies, no Referer, the net limit), checked
// by its magic bytes, at most 2 MB and 4096 px a side, and cached by URL for an hour; never SVG.
// The tree the window gets holds no http(s) URL in any Picture, and at most 4 MB of pictures.

import zlib from "node:zlib";
import { afterEach, describe, expect, it } from "vitest";
import { PICTURE_TREE_MAX, type AppWindow, type CoreEvent, type TreeElement, type TreeNode, type WidgetPatch, type WidgetTree } from "@cmd/protocol";
import { Core } from "../src/kernel/core.ts";
import { ApiRefusal } from "../src/widgets/api/access.ts";
import { PICTURE_LIMITS, PictureCache, checkDataSrc, fetchPicture, pictureUrl, sniff } from "../src/widgets/api/picture.ts";
import { fakeFactory } from "./fake-pty.ts";
import { FakeWidgetRuntime, tmp, until, writePackage } from "./fake-widget-runtime.ts";

// ── pictures, made here ─────────────────────────────────

const chunk = (type: string, data: Buffer) => {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const body = Buffer.concat([Buffer.from(type, "latin1"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(body));
  return Buffer.concat([len, body, crc]);
};
/** A PNG of `w`×`h` (one grey pixel's data: its size is the header's), with `pad` bytes more in a private chunk. */
function png(w = 2, h = 2, pad = 0): Buffer {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.set([8, 0, 0, 0, 0], 8);
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk("IHDR", ihdr), ...(pad ? [chunk("cmDd", Buffer.alloc(pad, 7))] : []), chunk("IDAT", zlib.deflateSync(Buffer.alloc(h * (w + 1)))), chunk("IEND", Buffer.alloc(0))]);
}
function jpeg(w: number, h: number): Buffer {
  const app0 = Buffer.from([0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01, 0x01, 0x00, 0x00, 0x01, 0x00, 0x01, 0x00, 0x00]);
  const sof = Buffer.from([0xff, 0xc0, 0x00, 0x11, 0x08, h >> 8, h & 0xff, w >> 8, w & 0xff, 0x03, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1]);
  return Buffer.concat([Buffer.from([0xff, 0xd8]), app0, sof, Buffer.from([0xff, 0xd9])]);
}
const gif = (w: number, h: number) => Buffer.concat([Buffer.from("GIF89a", "latin1"), Buffer.from([w & 0xff, w >> 8, h & 0xff, h >> 8, 0, 0, 0]), Buffer.from([0x3b])]);
function webp(w: number, h: number): Buffer {
  const b = Buffer.alloc(30);
  b.write("RIFF", 0, "latin1");
  b.writeUInt32LE(22, 4);
  b.write("WEBPVP8X", 8, "latin1");
  b.writeUInt32LE(10, 16);
  b.writeUIntLE(w - 1, 24, 3);
  b.writeUIntLE(h - 1, 27, 3);
  return b;
}
const SVG = Buffer.from('<?xml version="1.0"?><svg xmlns="http://www.w3.org/2000/svg"><script>fetch("https://evil.example/x")</script></svg>');
const dataUrl = (type: string, b: Buffer) => `data:image/${type};base64,${b.toString("base64")}`;

const refusal = async (p: Promise<unknown> | (() => unknown)): Promise<ApiRefusal> => {
  try {
    await (typeof p === "function" ? p() : p);
  } catch (e) {
    if (e instanceof ApiRefusal) return e;
    throw e;
  }
  throw new Error("not refused");
};

/** A fake server: each URL's response, and the requests it got. */
function server(routes: Record<string, () => Response>) {
  const asked: { url: string; headers: Record<string, string>; redirect?: string }[] = [];
  const impl = (async (u: URL | string, init: RequestInit) => {
    const url = String(u);
    asked.push({ url, headers: { ...(init.headers as Record<string, string>) }, redirect: init.redirect });
    const r = routes[url];
    if (!r) return new Response("not found", { status: 404 });
    return r();
  }) as unknown as typeof fetch;
  return { impl, asked };
}
const image = (b: Buffer, type = "image/png", headers: Record<string, string> = {}) => () => new Response(new Uint8Array(b), { status: 200, headers: { "content-type": type, ...headers } });

// ── the checks ──────────────────────────────────────────

describe("picture checks", () => {
  it("knows PNG, JPEG, WebP and GIF by their bytes, with their size", () => {
    expect(sniff(png(300, 200))).toEqual({ type: "png", width: 300, height: 200 });
    expect(sniff(jpeg(640, 480))).toEqual({ type: "jpeg", width: 640, height: 480 });
    expect(sniff(gif(16, 9))).toEqual({ type: "gif", width: 16, height: 9 });
    expect(sniff(webp(1000, 1))).toEqual({ type: "webp", width: 1000, height: 1 });
    expect(sniff(SVG)).toBeNull();
    expect(sniff(Buffer.from("<html><img src=x></html>"))).toBeNull();
  });

  it("refuses an SVG data: src by its type", async () => {
    const e = await refusal(() => checkDataSrc(dataUrl("svg+xml", SVG)));
    expect(e.message).toBe("Picture: a data: src is a base64 PNG, JPEG, WebP or GIF, never SVG.");
  });

  it("refuses an SVG data: src that says it is a PNG, by its magic bytes", async () => {
    const e = await refusal(() => checkDataSrc(dataUrl("png", SVG)));
    expect(e.message).toBe("Picture: its data: src is an SVG, which cmd never draws. Use a PNG, JPEG, WebP or GIF.");
    // A real JPEG that says it is a PNG isn't drawn either.
    expect((await refusal(() => checkDataSrc(dataUrl("png", jpeg(2, 2))))).message).toMatch(/says it's a PNG but is a JPEG/);
  });

  it("refuses a data: src over 512 KB", async () => {
    const big = dataUrl("png", png(2, 2, 400 * 1024));
    expect(big.length).toBeGreaterThan(512 * 1024);
    expect((await refusal(() => checkDataSrc(big))).message).toMatch(/at most 512 KB/);
    const fits = dataUrl("png", png(2, 2, 300 * 1024));
    expect(checkDataSrc(fits)).toBe(fits);
  });

  it("refuses a data: picture over 4096 px a side", async () => {
    expect((await refusal(() => checkDataSrc(dataUrl("png", png(4097, 10))))).message).toBe("Picture: its data: src is 4097×10 px; cmd draws pictures up to 4096 px a side.");
    expect(checkDataSrc(dataUrl("gif", gif(4096, 4096)))).toMatch(/^data:image\/gif;base64,/);
  });
});

// ── fetching ────────────────────────────────────────────

describe("fetching a picture", () => {
  const net = ["img.example.com"];
  const get = (url: string, impl: typeof fetch) => fetchPicture(pictureUrl(url, net), { net, fetchImpl: impl });

  it("fetches a granted host's picture as net.fetch does and hands on a data: URL", async () => {
    const s = server({ "https://img.example.com/cover.png": image(png(64, 64)) });
    expect(await get("https://img.example.com/cover.png", s.impl)).toBe(dataUrl("png", png(64, 64)));
    // cmd's user agent; no cookie, no Referer; redirects followed by hand (within the host only).
    expect(s.asked[0]!.headers["user-agent"]).toBe("cmd-widget/1");
    expect(Object.keys(s.asked[0]!.headers).filter((k) => /cookie|referer/i.test(k))).toEqual([]);
    expect(s.asked[0]!.redirect).toBe("manual");
  });

  it("refuses a host outside the grant before anything is fetched", async () => {
    const e = await refusal(() => pictureUrl("https://tracker.example.net/pixel.png", net));
    expect(e.error).toMatchObject({ code: "permission", permission: 'net: ["tracker.example.net"]' });
    expect((await refusal(() => pictureUrl("http://img.example.com/a.png", net))).message).toMatch(/https:\/\//);
    expect((await refusal(() => pictureUrl("https://u:p@img.example.com/a.png", net))).message).toMatch(/credentials/);
  });

  it("refuses a redirect to an ungranted host", async () => {
    const s = server({ "https://img.example.com/r": () => new Response(null, { status: 302, headers: { location: "https://tracker.example.net/pixel.png" } }), "https://tracker.example.net/pixel.png": image(png()) });
    const e = await refusal(get("https://img.example.com/r", s.impl));
    expect(e.message).toMatch(/redirected to tracker\.example\.net/);
    expect(s.asked.map((a) => a.url)).toEqual(["https://img.example.com/r"]);
  });

  it("refuses an SVG by its type, and an SVG served as image/png by its magic bytes", async () => {
    const s = server({ "https://img.example.com/a.svg": image(SVG, "image/svg+xml"), "https://img.example.com/a.png": image(SVG, "image/png") });
    expect((await refusal(get("https://img.example.com/a.svg", s.impl))).message).toBe("Picture: img.example.com sent image/svg+xml, which cmd never draws. Use a PNG, JPEG, WebP or GIF.");
    expect((await refusal(get("https://img.example.com/a.png", s.impl))).message).toBe("Picture: the picture from img.example.com is an SVG, which cmd never draws. Use a PNG, JPEG, WebP or GIF.");
  });

  it("refuses more than 2 MB, said or sent, and a side over 4096 px", async () => {
    const big = png(2, 2, PICTURE_LIMITS.fetch);
    const s = server({
      "https://img.example.com/said.png": image(big, "image/png", { "content-length": String(big.length) }),
      // No length: read up to 2 MB, then refused.
      "https://img.example.com/sent.png": () => new Response(new ReadableStream({ start: (c) => (c.enqueue(new Uint8Array(big)), c.close()) }), { status: 200, headers: { "content-type": "image/png" } }),
      "https://img.example.com/wide.jpg": image(jpeg(5000, 100), "image/jpeg"),
    });
    expect((await refusal(get("https://img.example.com/said.png", s.impl))).message).toMatch(/sent 3 MB; cmd fetches pictures up to 2 MB/);
    expect((await refusal(get("https://img.example.com/sent.png", s.impl))).message).toMatch(/sent more than 2 MB/);
    expect((await refusal(get("https://img.example.com/wide.jpg", s.impl))).message).toMatch(/is 5000×100 px; cmd draws pictures up to 4096 px a side/);
  });

  it("caches by URL for an hour, the least recently used going first past 32 MB", async () => {
    let now = 0;
    const cache = new PictureCache({ now: () => now });
    let fetched = 0;
    const one = () => (fetched++, Promise.resolve("data:image/png;base64,AAAA"));
    for (let i = 0; i < 50; i++) await cache.get("https://img.example.com/a.png", one);
    expect(fetched).toBe(1);
    now += PICTURE_LIMITS.keepMs - 1;
    await cache.get("https://img.example.com/a.png", one);
    expect(fetched).toBe(1);
    now += 2;
    await cache.get("https://img.example.com/a.png", one);
    expect(fetched).toBe(2);
    // Two at once: one request.
    await Promise.all([cache.get("https://img.example.com/b.png", one), cache.get("https://img.example.com/b.png", one)]);
    expect(fetched).toBe(3);
    // 32 MB: 17 pictures of 2 MB push the oldest out.
    const big = "x".repeat(2 * 1024 * 1024);
    for (let i = 0; i < 17; i++) await cache.get(`https://img.example.com/${i}`, () => Promise.resolve(big));
    expect(cache.size).toBeLessThanOrEqual(PICTURE_LIMITS.cache);
    const before = fetched;
    await cache.get("https://img.example.com/0", () => (fetched++, Promise.resolve(big)));
    expect(fetched).toBe(before + 1);
  });
});

// ── in a widget's tree ──────────────────────────────────

const cores: Core[] = [];
afterEach(async () => {
  for (const c of cores.splice(0)) await c.close();
});

async function setup(routes: Record<string, () => Response>) {
  const home = tmp("cmd-picture-home-");
  writePackage(home, { permissions: { net: ["img.example.com"] } });
  process.env.CMD_WIDGETS_HOME = home;
  const core = new Core({ socketPath: "", dbPath: null, settingsPath: null, terminals: fakeFactory().factory, pollMs: 0, stateDir: tmp("cmd-picture-state-") });
  delete process.env.CMD_WIDGETS_HOME;
  cores.push(core);
  const rt = new FakeWidgetRuntime(core.widgetTokens);
  core.library.host.configure({ runtime: rt, times: { pingMs: 20, stallMs: 1000, stopAfterMs: 100, restartMs: 5 } });
  const s = server(routes);
  core.library.host.fetchImpl = s.impl;
  const events: CoreEvent[] = [];
  core.serve({ access: "local", send: (line) => { const m = JSON.parse(line) as { method?: string; params?: CoreEvent }; if (m.method === "event") events.push(m.params!); }, close: () => {} }).receive(JSON.stringify({ id: 1, method: "events.subscribe", params: {} }));
  core.start();
  await core.scheduler.idle();
  core.library.host.grant("demo");
  const w = (await core.handlers["widget.add"]({ ref: "pkg:demo/main", workspaceId: core.workspaces.home().id })) as AppWindow;
  await until(() => core.library.host.status(w.id)?.state === "running", "the widget running");
  const sent = () => events.filter((e): e is Extract<CoreEvent, { type: "widget.tree" }> => e.type === "widget.tree" && e.windowId === w.id).map((e) => e.message).filter((m): m is WidgetTree | WidgetPatch => m.kind === "tree" || m.kind === "patch");
  const logs = () => events.filter((e): e is Extract<CoreEvent, { type: "widget.log" }> => e.type === "widget.log" && e.windowId === w.id).map((e) => e.message);
  return { core, rt, w, s, sent, logs };
}

const pic = (id: number, src: string | null, alt = "Cover"): TreeElement => ({ id, type: "Picture", props: { src, alt, size: 64 }, children: [] });
/** Every Picture src in what the window got. */
function srcs(messages: (WidgetTree | WidgetPatch)[]): unknown[] {
  const out: unknown[] = [];
  const walk = (n: TreeNode) => {
    if (n.type === "#text") return;
    if (n.type === "Picture" && "src" in n.props) out.push(n.props.src);
    n.children.forEach(walk);
  };
  for (const m of messages) {
    if (m.kind === "tree") m.nodes.forEach(walk);
    else for (const op of m.ops) op.op === "insert" ? walk(op.node) : op.op === "props" && "src" in op.set && out.push(op.set.src);
  }
  return out;
}

describe("Pictures in a widget's tree", () => {
  it("never sends the window an http(s) URL: an https src stands as null, then as the fetched data: URL", async () => {
    const { rt, s, sent } = await setup({ "https://img.example.com/cover.png": image(png(64, 64)) });
    const p = rt.last;
    p.send({ kind: "tree", rev: 1, nodes: [{ id: 1, type: "Stack", props: {}, children: [pic(2, "https://img.example.com/cover.png"), pic(3, "https://tracker.example.net/p.png"), pic(4, "http://img.example.com/c.png")] }] });
    await until(() => srcs(sent()).includes(dataUrl("png", png(64, 64))), "the fetched picture in a tree");
    p.send({ kind: "patch", rev: 2, ops: [{ op: "insert", parent: 1, index: 0, node: pic(5, "https://img.example.com/cover.png", "Again") }, { op: "props", id: 3, set: { src: "https://img.example.com/cover.png?x" }, unset: [] }] });
    await until(() => sent().some((m) => m.kind === "patch"), "the patch");
    const all = srcs(sent());
    expect(all.length).toBeGreaterThan(4);
    for (const src of all) expect(src === null || (typeof src === "string" && src.startsWith("data:image/png;base64,"))).toBe(true);
    expect(JSON.stringify(sent())).not.toMatch(/https?:\/\//);
    // Only granted hosts were asked.
    expect(s.asked.every((a) => a.url.startsWith("https://img.example.com/"))).toBe(true);
  });

  it("fetches one URL once within the hour, however often the tree redraws", async () => {
    const { rt, s, sent, core, w } = await setup({ "https://img.example.com/cover.png": image(png(8, 8)) });
    const p = rt.last;
    p.send({ kind: "tree", rev: 1, nodes: [pic(1, "https://img.example.com/cover.png")] });
    await until(() => srcs(sent()).includes(dataUrl("png", png(8, 8))), "the picture");
    for (let rev = 2; rev < 40; rev++) p.send({ kind: "patch", rev, ops: [{ op: "props", id: 1, set: { src: "https://img.example.com/cover.png", alt: `Cover ${rev}` }, unset: [] }] });
    // A whole tree again, and the window drawn again from scratch.
    p.send({ kind: "tree", rev: 40, nodes: [pic(1, "https://img.example.com/cover.png"), pic(2, "https://img.example.com/cover.png")] });
    core.library.host.resync(w.id);
    await until(() => sent().filter((m) => m.kind === "tree").length >= 4, "the trees");
    expect(s.asked.length).toBe(1);
    expect(srcs(sent()).slice(-2)).toEqual([dataUrl("png", png(8, 8)), dataUrl("png", png(8, 8))]);
  });

  it("refuses an SVG and a host outside the grant, saying why in the widget's log, once", async () => {
    const { rt, s, sent, logs } = await setup({ "https://img.example.com/a.png": image(SVG, "image/png") });
    rt.last.send({ kind: "tree", rev: 1, nodes: [pic(1, "https://img.example.com/a.png"), pic(2, "https://tracker.example.net/pixel.gif"), pic(3, dataUrl("svg+xml", SVG))] });
    await until(() => logs().length >= 3, "three log lines");
    expect(logs().sort()).toEqual([
      'Picture: a data: src is a base64 PNG, JPEG, WebP or GIF, never SVG.',
      'Picture: the picture from img.example.com is an SVG, which cmd never draws. Use a PNG, JPEG, WebP or GIF.',
      'Showing pictures from tracker.example.net needs net: ["tracker.example.net"] in package.json\'s cmd.permissions.',
    ]);
    expect(srcs(sent())).toEqual([null, null, null]);
    expect(s.asked.map((a) => a.url)).toEqual(["https://img.example.com/a.png"]);
  });

  it("holds at most 4 MB of pictures per tree: one past it shows its placeholder", async () => {
    const { rt, sent, logs } = await setup({});
    const each = dataUrl("png", png(2, 2, 370 * 1024));
    expect(each.length).toBeLessThan(512 * 1024);
    const fit = Math.floor(PICTURE_TREE_MAX / each.length);
    rt.last.send({ kind: "tree", rev: 1, nodes: Array.from({ length: fit + 2 }, (_, i) => pic(i + 1, each)) });
    await until(() => sent().length > 0, "the tree");
    const got = srcs(sent());
    expect(got.filter((x) => x === each).length).toBe(fit);
    expect(got.slice(fit)).toEqual([null, null]);
    expect(logs()).toEqual(["Picture: this window's pictures are over 4 MB together, so one shows its placeholder. Use smaller pictures."]);
    // One taken out makes room for another.
    rt.last.send({ kind: "patch", rev: 2, ops: [{ op: "remove", id: 1 }, { op: "props", id: fit + 2, set: { src: each }, unset: [] }] });
    await until(() => sent().some((m) => m.kind === "patch"), "the patch");
    expect(srcs(sent()).at(-1)).toBe(each);
  });

  it("counts fetched pictures against the widget's net limit", async () => {
    const routes: Record<string, () => Response> = {};
    for (let i = 0; i < 61; i++) routes[`https://img.example.com/${i}.png`] = image(png());
    const { rt, s, logs } = await setup(routes);
    rt.last.send({ kind: "tree", rev: 1, nodes: Array.from({ length: 61 }, (_, i) => pic(i + 1, `https://img.example.com/${i}.png`)) });
    await until(() => logs().some((l) => /at most 60 a minute/.test(l)), "the limit");
    expect(s.asked.length).toBe(60);
  });
});
