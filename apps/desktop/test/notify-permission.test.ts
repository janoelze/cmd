import { describe, expect, it, vi } from "vitest";

vi.mock("electron", () => ({ shell: {} }));
const { accessOf } = await import("../src/main/notify-permission.ts");

// What macOS's notification settings for cmd mean for Settings → Notifications → macOS.

describe("accessOf", () => {
  it("on only with banners or alerts", () => {
    expect(accessOf({ authorization: "authorized", alerts: true, style: "banner" })).toBe("on");
    expect(accessOf({ authorization: "authorized", alerts: true, style: "alert" })).toBe("on");
  });
  it("quiet when allowed but no banner", () => {
    expect(accessOf({ authorization: "authorized", alerts: true, style: "none" })).toBe("quiet");
    expect(accessOf({ authorization: "authorized", alerts: false, style: "banner" })).toBe("quiet");
    expect(accessOf({ authorization: "provisional", alerts: true, style: "banner" })).toBe("quiet");
  });
  it("ask before macOS asked, off when denied", () => {
    expect(accessOf({ authorization: "notDetermined", alerts: false, style: "none" })).toBe("ask");
    expect(accessOf({ authorization: "denied", alerts: false, style: "none" })).toBe("off");
  });
});
