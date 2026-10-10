import { describe, expect, it } from "vitest";
import { BROWSER_PARTITION, forgetDecision, guestPartitionAllowed, parseDecisions, permissionVerdict, siteOf } from "../src/main/web-policy.ts";

const SITE = "https://meet.example.com";

describe("browser session permissions", () => {
  it("never grant camera, location, notifications or opening apps without a kept answer", () => {
    for (const p of ["media", "geolocation", "notifications", "openExternal"]) expect(permissionVerdict(p, SITE, {})).toBe("ask");
  });

  it("grant fullscreen, pointer lock and sanitized clipboard writes to every page", () => {
    for (const p of ["fullscreen", "pointerLock", "clipboard-sanitized-write"]) {
      expect(permissionVerdict(p, SITE, {})).toBe("allow");
      expect(permissionVerdict(p, null, {})).toBe("allow");
    }
  });

  it("deny everything else", () => {
    for (const p of ["midi", "midiSysex", "clipboard-read", "hid", "serial", "usb", "idle-detection", "speaker-selection", "unknown"]) expect(permissionVerdict(p, SITE, {})).toBe("deny");
  });

  it("honour a kept answer for that site only", () => {
    const kept = { [SITE]: { media: true, geolocation: false } };
    expect(permissionVerdict("media", SITE, kept)).toBe("allow");
    expect(permissionVerdict("geolocation", SITE, kept)).toBe("deny");
    expect(permissionVerdict("notifications", SITE, kept)).toBe("ask");
    expect(permissionVerdict("media", "https://other.example.com", kept)).toBe("ask");
    expect(permissionVerdict("media", "http://meet.example.com", kept)).toBe("ask");
  });

  it("ask only for http(s) pages", () => {
    expect(siteOf("https://meet.example.com/room?x=1")).toBe(SITE);
    expect(siteOf("http://localhost:5173/a")).toBe("http://localhost:5173");
    for (const u of ["file:///tmp/a.html", "about:blank", "data:text/html,x", "cmd-widget://frame/", "", undefined]) expect(siteOf(u)).toBeNull();
    expect(permissionVerdict("media", siteOf("file:///tmp/a.html"), {})).toBe("deny");
  });

  it("read only well-formed answers from site-permissions.json", () => {
    expect(parseDecisions({ [SITE]: { media: true, midi: true, geolocation: "yes" }, "not a site": { media: true }, "https://a.example.com/path": { media: true } })).toEqual({ [SITE]: { media: true } });
    expect(parseDecisions(null)).toEqual({});
    expect(parseDecisions([1, 2])).toEqual({});
  });
});

describe("will-attach-webview", () => {
  it("refuses a guest in any session but the browser one", () => {
    expect(guestPartitionAllowed(BROWSER_PARTITION)).toBe(true);
    for (const p of [undefined, "", "persist:other", "cmd-widget-preview", "persist:cmd-browser ", "cmd-browser"]) expect(guestPartitionAllowed(p)).toBe(false);
  });

  it("forget one answer, or all of a site's, and nothing else (Settings → Browser)", () => {
    const other = "https://other.example.com";
    const kept = { [SITE]: { media: true, notifications: false }, [other]: { geolocation: true } };
    expect(forgetDecision(kept, SITE, "media")).toEqual({ [SITE]: { notifications: false }, [other]: { geolocation: true } });
    expect(Object.keys(forgetDecision(kept, SITE, "media"))).toEqual([SITE, other]);
    expect(forgetDecision(kept, SITE, null)).toEqual({ [other]: { geolocation: true } });
    expect(forgetDecision(kept, other, "geolocation")).toEqual({ [SITE]: kept[SITE] });
    // Nothing kept: the same object, so nothing is written.
    expect(forgetDecision(kept, SITE, "geolocation")).toBe(kept);
    expect(forgetDecision(kept, "https://new.example.com", null)).toBe(kept);
    expect(kept[SITE]).toEqual({ media: true, notifications: false });
  });

  it("refuse anything but an origin and a permission cmd asks for", () => {
    const kept = { [SITE]: { media: true } };
    for (const site of [`${SITE}/path`, "file:///tmp", "not a site", "", 1, null, undefined, { [SITE]: true }, "__proto__"]) expect(() => forgetDecision(kept, site, "media")).toThrow();
    for (const kind of ["midi", "", "__proto__", "toString", 1, undefined, { media: true }, ["media"]]) expect(() => forgetDecision(kept, SITE, kind)).toThrow();
  });
});
