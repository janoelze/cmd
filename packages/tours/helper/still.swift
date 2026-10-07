// Experiment: one still of an app two ways, to see what each ScreenCaptureKit
// filter includes (native menus are separate windows of the app).
//   still <pid> <out-dir>  → display-including-app.png, window-only.png
// Build: swiftc -O still.swift -o still

import Cocoa
import ScreenCaptureKit
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]) else { print("usage: still <pid> <out-dir>"); exit(2) }
let out = URL(fileURLWithPath: args[2])

func save(_ image: CGImage, _ name: String) throws {
  let url = out.appendingPathComponent(name)
  guard let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil) else { throw NSError(domain: "still", code: 1) }
  CGImageDestinationAddImage(dest, image, nil)
  CGImageDestinationFinalize(dest)
  print("saved \(name) \(image.width)x\(image.height)")
}

let done = DispatchSemaphore(value: 0)
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let app = content.applications.first(where: { $0.processID == pid }) else { print("no app with pid \(pid)"); exit(1) }
    let windows = content.windows.filter { $0.owningApplication?.processID == pid }
    for w in windows { print("window layer=\(w.windowLayer) \(Int(w.frame.width))x\(Int(w.frame.height)) title=\(w.title ?? "-")") }
    let display = content.displays.first!
    let scale = Int(NSScreen.main?.backingScaleFactor ?? 2)

    let config = SCStreamConfiguration()
    config.width = display.width * scale
    config.height = display.height * scale
    config.showsCursor = false
    try save(try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(display: display, including: [app], exceptingWindows: []), configuration: config), "display-including-app.png")

    if let main = windows.filter({ $0.windowLayer == 0 }).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) {
      let wc = SCStreamConfiguration()
      wc.width = Int(main.frame.width) * scale
      wc.height = Int(main.frame.height) * scale
      wc.showsCursor = false
      try save(try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: main), configuration: wc), "window-only.png")
    }
  } catch {
    print("error: \(error.localizedDescription)")
  }
  done.signal()
}
_ = done.wait(timeout: .now() + 20)
