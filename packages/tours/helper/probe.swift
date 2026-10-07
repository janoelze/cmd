// Checks what a tour recording needs from macOS, one capability a line:
// Accessibility (to post input and read native menus), Screen Recording,
// ScreenCaptureKit (list windows, grab one frame), posting an input event and
// encoding video (VideoToolbox).
// Exits non-zero if any fails. --request asks macOS for the permissions
// (the prompt names the app the command runs in, e.g. cmd).
// Build: swiftc -O probe.swift -o probe

import ApplicationServices
import Cocoa
import ScreenCaptureKit
import VideoToolbox

let request = CommandLine.arguments.contains("--request")
var failed = false
func report(_ name: String, _ ok: Bool, _ detail: String = "") {
  print("\(ok ? "ok  " : "FAIL") \(name)\(detail.isEmpty ? "" : ": \(detail)")")
  if !ok { failed = true }
}

let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: request] as CFDictionary
report("accessibility", AXIsProcessTrustedWithOptions(axOptions))
report("screen recording", request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess())

// An app's menu bar through the Accessibility API, the way the driver finds
// native menus: by the app's pid. (The system-wide "focused application" is
// unreliable from a command-line tool, AXError -25204.) Finder always runs.
if let finder = NSWorkspace.shared.runningApplications.first(where: { $0.bundleIdentifier == "com.apple.finder" }) {
  var bar: CFTypeRef?
  let axErr = AXUIElementCopyAttributeValue(AXUIElementCreateApplication(finder.processIdentifier), kAXMenuBarAttribute as CFString, &bar)
  var items: CFTypeRef?
  if axErr == .success { AXUIElementCopyAttributeValue(bar as! AXUIElement, kAXChildrenAttribute as CFString, &items) }
  report("accessibility read", axErr == .success, axErr == .success ? "Finder's menu bar, \((items as? [AnyObject])?.count ?? 0) menus" : "AXError \(axErr.rawValue)")
} else {
  report("accessibility read", false, "Finder isn't running")
}

// Post a mouse move to where the pointer already is: harmless, but goes through the real input path.
let here = CGEvent(source: nil)?.location ?? .zero
if let move = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: .mouseMoved, mouseCursorPosition: here, mouseButton: .left) {
  move.post(tap: .cghidEventTap)
  report("post input event", true, "(posted; only Accessibility makes it count)")
} else {
  report("post input event", false, "could not create the event")
}

// Encoding the recording goes through VideoToolbox's system services: start a
// session and encode one frame.
do {
  var session: VTCompressionSession?
  var st = VTCompressionSessionCreate(allocator: nil, width: 640, height: 480, codecType: kCMVideoCodecType_HEVC, encoderSpecification: nil, imageBufferAttributes: nil, compressedDataAllocator: nil, outputCallback: nil, refcon: nil, compressionSessionOut: &session)
  if st == noErr, let session {
    var pixels: CVPixelBuffer?
    CVPixelBufferCreate(nil, 640, 480, kCVPixelFormatType_32BGRA, nil, &pixels)
    st = VTCompressionSessionEncodeFrame(session, imageBuffer: pixels!, presentationTimeStamp: .zero, duration: .invalid, frameProperties: nil, infoFlagsOut: nil) { _, _, _ in }
    if st == noErr { st = VTCompressionSessionCompleteFrames(session, untilPresentationTimeStamp: .invalid) }
    VTCompressionSessionInvalidate(session)
  }
  report("video encoding", st == noErr, st == noErr ? "HEVC" : "VideoToolbox \(st)")
}

let done = DispatchSemaphore(value: 0)
Task {
  do {
    let content = try await SCShareableContent.excludingDesktopWindows(false, onScreenWindowsOnly: true)
    report("screencapturekit list", true, "\(content.displays.count) displays, \(content.windows.count) windows")
    if let display = content.displays.first {
      let filter = SCContentFilter(display: display, excludingWindows: [])
      let config = SCStreamConfiguration()
      config.width = display.width
      config.height = display.height
      let image = try await SCScreenshotManager.captureImage(contentFilter: filter, configuration: config)
      report("screencapturekit frame", true, "\(image.width)x\(image.height)")
    }
  } catch {
    report("screencapturekit", false, error.localizedDescription)
  }
  done.signal()
}
if done.wait(timeout: .now() + 15) == .timedOut { report("screencapturekit", false, "no answer in 15 s") }
exit(failed ? 1 : 0)
