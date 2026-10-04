// Device size presets for browser windows (right-click a browser window → Device
// Size). A preset fixes the page's viewport to the device's size in CSS pixels,
// scaled down to fit the window, and phones send their own user agent so sites
// that sniff it serve their mobile pages. Stored by id in the window's state.

export interface Device {
  id: string;
  name: string;
  width: number;
  height: number;
  /** The user agent the device's browser sends; none: the app's own. */
  userAgent?: string;
}

const IOS_UA =
  "Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1";
const ANDROID_UA =
  "Mozilla/5.0 (Linux; Android 15; Pixel 9) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Mobile Safari/537.36";

/** Grouped for the menu: phones, tablet, desktops. */
export const DEVICES: Device[][] = [
  [
    { id: "iphone-se", name: "iPhone SE", width: 375, height: 667, userAgent: IOS_UA },
    { id: "iphone-16", name: "iPhone 16", width: 393, height: 852, userAgent: IOS_UA },
    { id: "iphone-16-pro-max", name: "iPhone 16 Pro Max", width: 440, height: 956, userAgent: IOS_UA },
    { id: "pixel-9", name: "Pixel 9", width: 412, height: 923, userAgent: ANDROID_UA },
  ],
  // iPadOS Safari presents itself as a Mac, so iPads keep the app's user agent.
  [{ id: "ipad-air", name: "iPad Air", width: 820, height: 1180 }],
  [
    { id: "laptop", name: "Laptop", width: 1280, height: 800 },
    { id: "macbook-air", name: "MacBook Air 13″", width: 1470, height: 956 },
    { id: "desktop-hd", name: "Desktop HD", width: 1920, height: 1080 },
  ],
];

export function deviceById(id: string | undefined): Device | undefined {
  return id ? DEVICES.flat().find((d) => d.id === id) : undefined;
}
