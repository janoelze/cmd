// Checks what a tour recording needs from macOS, one capability a line:
// Accessibility (to post input and read native menus), Screen Recording,
// ScreenCaptureKit (list windows, grab one frame) and posting an input event.
// Exits non-zero if any fails. --request asks macOS for the permissions
// (the prompt names the app the command runs in, e.g. cmd).
// Build: swiftc -O probe.swift -o probe

import ApplicationServices
import Cocoa
import ScreenCaptureKit

let request = CommandLine.arguments.contains("--request")
var failed = false
func report(_ name: String, _ ok: Bool, _ detail: String = "") {
  print("\(ok ? "ok  " : "FAIL") \(name)\(detail.isEmpty ? "" : ": \(detail)")")
  if !ok { failed = true }
}

let axOptions = [kAXTrustedCheckOptionPrompt.takeUnretainedValue() as String: request] as CFDictionary
report("accessibility", AXIsProcessTrustedWithOptions(axOptions))
report("screen recording", request ? CGRequestScreenCaptureAccess() : CGPreflightScreenCaptureAccess())

// The menu bar of the frontmost app, through the Accessibility API (how native menus are found).
let system = AXUIElementCreateSystemWide()
var front: CFTypeRef?
let axErr = AXUIElementCopyAttributeValue(system, kAXFocusedApplicationAttribute as CFString, &front)
report("accessibility read", axErr == .success, axErr == .success ? "" : "AXError \(axErr.rawValue)")

// Post a mouse move to where the pointer already is: harmless, but goes through the real input path.
let here = CGEvent(source: nil)?.location ?? .zero
if let move = CGEvent(mouseEventSource: CGEventSource(stateID: .hidSystemState), mouseType: .mouseMoved, mouseCursorPosition: here, mouseButton: .left) {
  move.post(tap: .cghidEventTap)
  report("post input event", true, "(posted; only Accessibility makes it count)")
} else {
  report("post input event", false, "could not create the event")
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
