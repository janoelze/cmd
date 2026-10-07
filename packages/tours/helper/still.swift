// One still of an app's main window alone, with its real shadow and
// transparency (PNG with alpha), for compositing: the opaque pixels are the
// window's exact shape (rounded corners), the rest is macOS's own shadow.
//   still <pid> <out.png>  → prints the window's frame and the image size
// Build: swiftc -O still.swift -o still

import Cocoa
import ScreenCaptureKit
import UniformTypeIdentifiers

let args = CommandLine.arguments
guard args.count == 3, let pid = Int32(args[1]) else { print("usage: still <pid> <out.png>"); exit(2) }

let done = DispatchSemaphore(value: 0)
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
    guard let main = content.windows.filter({ $0.owningApplication?.processID == pid && $0.windowLayer == 0 }).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { print("no window"); exit(1) }
    let scale = Int(NSScreen.main?.backingScaleFactor ?? 2)
    let config = SCStreamConfiguration()
    config.ignoreShadowsSingleWindow = false
    config.showsCursor = false
    config.captureResolution = .best
    // Room for the shadow around the window.
    let pad = 80.0
    config.width = Int(main.frame.width + 2 * pad) * scale
    config.height = Int(main.frame.height + 2 * pad) * scale
    let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: main), configuration: config)
    let url = URL(fileURLWithPath: args[2])
    let dest = CGImageDestinationCreateWithURL(url as CFURL, UTType.png.identifier as CFString, 1, nil)!
    CGImageDestinationAddImage(dest, image, nil)
    CGImageDestinationFinalize(dest)
    print("{\"frame\":[\(main.frame.minX),\(main.frame.minY),\(main.frame.width),\(main.frame.height)],\"image\":[\(image.width),\(image.height)],\"alpha\":\(image.alphaInfo.rawValue)}")
  } catch {
    print("error: \(error.localizedDescription)")
  }
  done.signal()
}
_ = done.wait(timeout: .now() + 20)
