// The tour helper: what a tour needs from macOS, driven by the Node driver as
// JSON lines on stdin, one reply line each on stdout.
//
//   {"cmd":"record-start","pid":123,"out":"/x/raw.mov","rect":[x,y,w,h]?,"fps":60}
//       Records the display, showing only that app's windows (its context menus
//       and menu-bar menus included), cropped to `rect` (screen points), without
//       the system cursor: the cursor is drawn later from the event log.
//   {"cmd":"record-stop"}  → {"ok":true,"frames":n,"t0":ns,"t1":ns}
//
// Input, posted as real events (screen points, top-left origin) and logged:
//   {"cmd":"path","points":[[ms,x,y],…],"button":"left"?}   moves (drags with a button held)
//   {"cmd":"down"|"up","x":…,"y":…,"button":"left"|"right","clicks":1}
//   {"cmd":"scroll","x":…,"y":…,"steps":[[ms,dy,phase],…]}  trackpad-style, pixel deltas
//   {"cmd":"type","text":"…","delays":[ms,…]}               characters, layout-independent
//   {"cmd":"key","key":"Return","mods":["cmd"]}
//   {"cmd":"log"} → {"events":[…]} and clears it
// Moves stop with an error if the pointer isn't where the last move left it:
// someone moved the mouse, so the run is spoiled and shouldn't fight them.
//
// Times are host-clock nanoseconds (mach_absolute_time in ns), the clock of
// ScreenCaptureKit's sample buffers. Node's process.hrtime is a different clock
// (it counts sleep), so the helper keeps time: it posts and logs all input, and
// the driver asks it for "now" when it needs a timestamp.
// Build: swiftc -O tour-helper.swift -o tour-helper

import AVFoundation
import Cocoa
import CoreMedia
import ScreenCaptureKit

setvbuf(stdout, nil, _IOLBF, 0)

func reply(_ obj: [String: Any]) {
  let data = try! JSONSerialization.data(withJSONObject: obj)
  print(String(data: data, encoding: .utf8)!)
}

func nowNs() -> UInt64 { clock_gettime_nsec_np(CLOCK_UPTIME_RAW) }

/** One recording: a stream into an asset writer, frames timed by their capture time. */
final class Recorder: NSObject, SCStreamOutput, SCStreamDelegate {
  let stream: SCStream
  let writer: AVAssetWriter
  let input: AVAssetWriterInput
  let queue = DispatchQueue(label: "tour.capture")
  var frames = 0
  var t0: CMTime?
  var last: CMTime?
  /** The frame count when the writer failed, -1 if it didn't. */
  var failedAt = -1

  init(filter: SCContentFilter, config: SCStreamConfiguration, out: URL) throws {
    try? FileManager.default.removeItem(at: out)
    writer = try AVAssetWriter(outputURL: out, fileType: .mov)
    input = AVAssetWriterInput(mediaType: .video, outputSettings: [
      AVVideoCodecKey: AVVideoCodecType.hevc,
      AVVideoWidthKey: config.width,
      AVVideoHeightKey: config.height,
      // High enough that terminal text stays crisp; post re-encodes for delivery.
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 60_000_000, AVVideoExpectedSourceFrameRateKey: 60],
    ])
    input.expectsMediaDataInRealTime = true
    writer.add(input)
    stream = SCStream(filter: filter, configuration: config, delegate: nil)
    super.init()
    try stream.addStreamOutput(self, type: .screen, sampleHandlerQueue: queue)
  }

  func stream(_ stream: SCStream, didOutputSampleBuffer sample: CMSampleBuffer, of type: SCStreamOutputType) {
    guard type == .screen, sample.isValid,
      let attachments = CMSampleBufferGetSampleAttachmentsArray(sample, createIfNecessary: false) as? [[SCStreamFrameInfo: Any]],
      let raw = attachments.first?[.status] as? Int, SCFrameStatus(rawValue: raw) == .complete
    else { return }
    let pts = CMSampleBufferGetPresentationTimeStamp(sample)
    if t0 == nil {
      writer.startWriting()
      writer.startSession(atSourceTime: pts)
      t0 = pts
    }
    if writer.status == .failed {
      if failedAt < 0 { failedAt = frames }
      return
    }
    if input.isReadyForMoreMediaData {
      input.append(sample)
      frames += 1
      last = pts
    }
  }

  func stop() async throws -> [String: Any] {
    try await stream.stopCapture()
    await withCheckedContinuation { (done: CheckedContinuation<Void, Never>) in
      queue.async {
        self.input.markAsFinished()
        self.writer.finishWriting { done.resume() }
      }
    }
    let ns = { (t: CMTime?) in t.map { UInt64(CMTimeGetSeconds($0) * 1e9) } ?? 0 }
    return ["ok": true, "frames": frames, "t0": ns(t0), "t1": ns(last), "status": writer.status.rawValue, "error": writer.error.map { String(describing: $0 as NSError) } ?? NSNull(), "failedAt": failedAt]
  }
}

var recorder: Recorder?

// ── input ──────────────────────────────────────────

var events: [[String: Any]] = []
func log(_ type: String, _ fields: [String: Any]) {
  var e = fields
  e["t"] = nowNs()
  e["type"] = type
  events.append(e)
}

func waitUntil(_ ns: UInt64) {
  while true {
    let now = nowNs()
    if now >= ns { return }
    let left = ns - now
    if left > 2_000_000 { usleep(UInt32((left - 1_000_000) / 1000)) }
  }
}

let source = CGEventSource(stateID: .hidSystemState)
var lastPosted: CGPoint?

struct Interfered: Error, LocalizedError {
  let at: CGPoint
  let expected: CGPoint
  var errorDescription: String? { "the mouse moved (it's at \(Int(at.x)),\(Int(at.y)), the tour left it at \(Int(expected.x)),\(Int(expected.y))): someone is using it, so the tour stopped" }
}

func pointer() -> CGPoint { CGEvent(source: nil)?.location ?? .zero }

/**
 * Before a command: the pointer should be where the last posted event put it.
 * Posted events land a few ms later, so give it up to 60 ms to get there.
 */
func checkPointer() throws {
  guard let last = lastPosted else { return }
  let until = nowNs() + 60_000_000
  while true {
    let now = pointer()
    if abs(now.x - last.x) <= 3 && abs(now.y - last.y) <= 3 { return }
    if nowNs() > until { throw Interfered(at: now, expected: last) }
    usleep(5_000)
  }
}

func buttonOf(_ name: String?) -> (CGMouseButton, CGEventType, CGEventType, CGEventType) {
  name == "right" ? (.right, .rightMouseDown, .rightMouseUp, .rightMouseDragged) : (.left, .leftMouseDown, .leftMouseUp, .leftMouseDragged)
}

func post(_ type: CGEventType, _ p: CGPoint, _ button: CGMouseButton, clicks: Int64 = 1) {
  guard let e = CGEvent(mouseEventSource: source, mouseType: type, mouseCursorPosition: p, mouseButton: button) else { return }
  e.setIntegerValueField(.mouseEventClickState, value: clicks)
  e.post(tap: .cghidEventTap)
  lastPosted = p
}

func path(_ points: [[Double]], button: String?) throws {
  let (b, _, _, dragged) = buttonOf(button)
  try checkPointer()
  let start = nowNs()
  for pt in points where pt.count == 3 {
    waitUntil(start + UInt64(pt[0] * 1e6))
    let p = CGPoint(x: pt[1], y: pt[2])
    post(button == nil ? .mouseMoved : dragged, p, b)
    log("move", ["x": p.x, "y": p.y, "drag": button != nil])
  }
}

// Trackpad phases (CGScrollPhase, CGMomentumScrollPhase) by the planner's names.
let SCROLL_PHASE: [String: (Int64, Int64)] = [
  "began": (1, 0), "changed": (2, 0), "ended": (4, 0),
  "momentum-began": (0, 1), "momentum": (0, 2), "momentum-ended": (0, 3),
]

func scroll(at p: CGPoint, _ steps: [[Any]]) throws {
  try checkPointer()
  let start = nowNs()
  for step in steps where step.count == 3 {
    guard let ms = step[0] as? Double, let dy = step[1] as? Double, let name = step[2] as? String, let (phase, momentum) = SCROLL_PHASE[name] else { continue }
    waitUntil(start + UInt64(ms * 1e6))
    // Positive dy goes down the page; a wheel delta goes the other way.
    guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 1, wheel1: Int32(-dy), wheel2: 0, wheel3: 0) else { continue }
    e.location = p
    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    e.post(tap: .cghidEventTap)
    log("scroll", ["x": p.x, "y": p.y, "dy": dy, "phase": name])
  }
}

// Virtual key codes for keys that aren't text (and letters, for shortcuts; ANSI positions).
let KEYS: [String: CGKeyCode] = [
  "Return": 36, "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32,
  "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ",": 43, ".": 47, "/": 44,
]
let MODS: [String: CGEventFlags] = ["cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "ctrl": .maskControl]

func key(_ name: String, mods: [String]) throws {
  guard let code = KEYS[name] else { throw NSError(domain: "tour", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown key \(name)"]) }
  let flags = mods.reduce(CGEventFlags()) { $0.union(MODS[$1] ?? []) }
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    if down { usleep(70_000) }
  }
  log("key", ["key": name, "mods": mods])
}

func type(_ text: String, delays: [Double]) {
  let start = nowNs()
  var at = 0.0
  for (i, ch) in text.enumerated() {
    at += i < delays.count ? delays[i] : 70
    waitUntil(start + UInt64(at * 1e6))
    if ch == "\n" {
      try? key("Return", mods: [])
      continue
    }
    let units = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      e?.post(tap: .cghidEventTap)
      if down { usleep(useconds_t(min(90_000, max(30_000, (i + 1 < delays.count ? delays[i + 1] : 70) * 600)))) }
    }
    log("char", ["char": String(ch)])
  }
}

func handle(_ msg: [String: Any]) async {
  let cmd = msg["cmd"] as? String ?? ""
  do {
    switch cmd {
    case "record-start":
      guard let pid = msg["pid"] as? Int32, let out = msg["out"] as? String else { return reply(["ok": false, "error": "pid and out are needed"]) }
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      guard let app = content.applications.first(where: { $0.processID == pid }) else { return reply(["ok": false, "error": "no app with pid \(pid)"]) }
      // The display the app's biggest window is on.
      let windows = content.windows.filter { $0.owningApplication?.processID == pid && $0.windowLayer == 0 }
      let main = windows.max { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }
      let display = content.displays.first { d in main.map { d.frame.intersects($0.frame) } ?? false } ?? content.displays[0]
      let scale = Int(NSScreen.screens.first { $0.frame.size == display.frame.size }?.backingScaleFactor ?? 2)
      let config = SCStreamConfiguration()
      // The crop, in the display's own points.
      var crop = CGRect(x: 0, y: 0, width: display.width, height: display.height)
      if let r = msg["rect"] as? [Double], r.count == 4 {
        crop = CGRect(x: r[0] - display.frame.minX, y: r[1] - display.frame.minY, width: r[2], height: r[3])
        config.sourceRect = crop
      }
      config.width = Int(crop.width) * scale
      config.height = Int(crop.height) * scale
      let fps = msg["fps"] as? Int32 ?? 60
      config.minimumFrameInterval = CMTime(value: 1, timescale: fps)
      config.showsCursor = false
      config.pixelFormat = kCVPixelFormatType_32BGRA
      config.queueDepth = 6
      config.colorSpaceName = CGColorSpace.sRGB
      let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
      let rec = try Recorder(filter: filter, config: config, out: URL(fileURLWithPath: out))
      try await rec.stream.startCapture()
      recorder = rec
      reply(["ok": true, "width": config.width, "height": config.height, "scale": scale, "now": nowNs()])
    case "record-stop":
      guard let rec = recorder else { return reply(["ok": false, "error": "not recording"]) }
      recorder = nil
      reply(try await rec.stop())
    case "now":
      reply(["ok": true, "now": nowNs()])
    case "pointer":
      let p = pointer()
      reply(["ok": true, "x": p.x, "y": p.y])
    case "path":
      try path(msg["points"] as? [[Double]] ?? [], button: msg["button"] as? String)
      reply(["ok": true])
    case "down", "up":
      let p = CGPoint(x: msg["x"] as? Double ?? 0, y: msg["y"] as? Double ?? 0)
      try checkPointer()
      let (b, down, up, _) = buttonOf(msg["button"] as? String)
      let clicks = Int64(msg["clicks"] as? Int ?? 1)
      post(cmd == "down" ? down : up, p, b, clicks: clicks)
      log(cmd, ["x": p.x, "y": p.y, "button": msg["button"] as? String ?? "left", "clicks": clicks])
      reply(["ok": true])
    case "scroll":
      try scroll(at: CGPoint(x: msg["x"] as? Double ?? 0, y: msg["y"] as? Double ?? 0), msg["steps"] as? [[Any]] ?? [])
      reply(["ok": true])
    case "type":
      type(msg["text"] as? String ?? "", delays: msg["delays"] as? [Double] ?? [])
      reply(["ok": true])
    case "key":
      try key(msg["key"] as? String ?? "", mods: msg["mods"] as? [String] ?? [])
      reply(["ok": true])
    case "log":
      reply(["ok": true, "events": events])
      events = []
    case "release":
      // Stop guarding the pointer (between runs, or when the driver hands it back).
      lastPosted = nil
      reply(["ok": true])
    default:
      reply(["ok": false, "error": "unknown command \(cmd)"])
    }
  } catch {
    reply(["ok": false, "error": error.localizedDescription])
  }
}

// Commands run one at a time, in order.
Task {
  while let line = readLine() {
    guard let data = line.data(using: .utf8), let msg = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else {
      reply(["ok": false, "error": "not JSON"])
      continue
    }
    await handle(msg)
  }
  exit(0)
}
dispatchMain()
