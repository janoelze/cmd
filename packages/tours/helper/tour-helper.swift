// The tour helper: what a tour needs from macOS, driven by the Node driver as
// JSON lines on stdin, one reply line each on stdout.
//
//   {"cmd":"record-start","pid":123,"out":"/x/raw.mov","rect":[x,y,w,h]?,"fps":60,"cursors":"/x/cursors"?}
//       Records the display, showing only that app's windows (its context menus
//       and menu-bar menus included), cropped to `rect` (screen points), without
//       the system cursor: the cursor is drawn later from the event log. With
//       "cursors", the real system cursor's shape is watched: each new shape is
//       saved there as cursor-<id>.png (its largest image) and every change is
//       logged as {"type":"cursor","id":…,"w":…,"h":…,"hx":…,"hy":…} (points).
//   {"cmd":"record-stop"}  → {"ok":true,"frames":n,"t0":ns,"t1":ns}
//   {"cmd":"window-still","pid":123,"out":"/x/window.png"} → {"frame":[x,y,w,h],"size":[w,h]}
//       The app's main window alone with its real shadow, transparent around it:
//       post takes the window's exact shape and macOS's shadow from it.
//
// Input, posted as real events (screen points, top-left origin) and logged:
//   {"cmd":"path","points":[[ms,x,y],…],"button":"left"?}   moves (drags with a button held)
//   {"cmd":"down"|"up","x":…,"y":…,"button":"left"|"right","clicks":1}
//   {"cmd":"scroll","x":…,"y":…,"steps":[[ms,d,phase],…],"axis":"y"|"x"}  trackpad-style, pixel deltas
//       (d > 0 scrolls down the page, or right along it); "dir":[ux,uy] instead of axis:
//       a gesture along that direction (panning a canvas); "mods":["cmd"] held (⌘-scroll zooms)
//   {"cmd":"type","text":"…","delays":[ms,…]}               characters, layout-independent
//   {"cmd":"key","key":"Return","mods":["cmd"]}
//   {"cmd":"menu-items","pid":123} → {"items":[{title,x,y,w,h,enabled}]}: the app's open
//       native menus (context menus, an open menu-bar menu), via ScreenCaptureKit + Accessibility
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
import UniformTypeIdentifiers

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
      AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: 80_000_000, AVVideoExpectedSourceFrameRateKey: 120],
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

// ── the system cursor's shape ──────────────────────

var cursorDir: URL?
var cursorTimer: DispatchSourceTimer?
var cursorIds: [Data: Int] = [:]
var cursorNow = -1

/** Logs the system cursor when its shape changed (arrow, I-beam, resize…), saving each new shape once. */
func sampleCursor() {
  guard let dir = cursorDir, let c = NSCursor.currentSystem, let tiff = c.image.tiffRepresentation else { return }
  var key = tiff
  withUnsafeBytes(of: c.hotSpot) { key.append(contentsOf: $0) }
  let id: Int
  if let known = cursorIds[key] {
    id = known
  } else {
    id = cursorIds.count
    cursorIds[key] = id
    // The largest image, so it stays sharp when the video zooms in.
    if let best = c.image.representations.max(by: { $0.pixelsWide < $1.pixelsWide }) as? NSBitmapImageRep ?? NSBitmapImageRep(data: tiff),
      let png = best.representation(using: .png, properties: [:])
    {
      try? png.write(to: dir.appendingPathComponent("cursor-\(id).png"))
    }
  }
  if id != cursorNow {
    cursorNow = id
    log("cursor", ["id": id, "w": c.image.size.width, "h": c.image.size.height, "hx": c.hotSpot.x, "hy": c.hotSpot.y])
  }
}

func watchCursor(_ dir: URL?) {
  cursorTimer?.cancel()
  cursorTimer = nil
  cursorDir = dir
  cursorIds = [:]
  cursorNow = -1
  guard let dir else { return }
  try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
  let t = DispatchSource.makeTimerSource(queue: .main)
  t.schedule(deadline: .now(), repeating: .milliseconds(30))
  t.setEventHandler { sampleCursor() }
  t.resume()
  cursorTimer = t
}

// ── input ──────────────────────────────────────────

// Logged from commands and from the cursor timer (main queue): one lock.
var events: [[String: Any]] = []
let eventsLock = NSLock()
func log(_ type: String, _ fields: [String: Any]) {
  var e = fields
  e["t"] = nowNs()
  e["type"] = type
  eventsLock.withLock { events.append(e) }
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

/** Ticks on every refresh of the display a point is on (CVDisplayLink). */
final class VSync {
  private var link: CVDisplayLink?
  private let tick = DispatchSemaphore(value: 0)

  init?(at p: CGPoint) {
    var id: CGDirectDisplayID = 0
    var n: UInt32 = 0
    CGGetDisplaysWithPoint(p, 1, &id, &n)
    guard n > 0, CVDisplayLinkCreateWithCGDisplay(id, &link) == kCVReturnSuccess, let link else { return nil }
    CVDisplayLinkSetOutputCallback(link, { _, _, _, _, _, ctx in
      Unmanaged<VSync>.fromOpaque(ctx!).takeUnretainedValue().tick.signal()
      return kCVReturnSuccess
    }, Unmanaged.passUnretained(self).toOpaque())
    CVDisplayLinkStart(link)
  }

  /** Until the next refresh (ticks that came while we were busy don't count). */
  func next() {
    while tick.wait(timeout: .now()) == .success {}
    _ = tick.wait(timeout: .now() + .milliseconds(100))
  }

  deinit {
    if let link { CVDisplayLinkStop(link) }
  }
}

/**
 * A trackpad gesture, posted in step with the display: one event per refresh,
 * carrying exactly how far the planned curve moved since the last one. Posting
 * on our own clock (even at 120 Hz) gave the app one event in some frames and
 * three in others, so the scroll moved 10, 28, 9, 26 px a frame: judder.
 * `steps` is the planner's curve ([ms, distance, phase], flings starting at
 * "began"); only its shape and timing are used, the events are new.
 */
func scroll(at p: CGPoint, _ steps: [[Any]], sideways: Bool = false, dir: [Double]? = nil, mods: [String] = []) throws {
  try checkPointer()
  let flags = mods.reduce(CGEventFlags()) { $0.union(MODS[$1] ?? []) }
  let along = dir.flatMap { $0.count == 2 ? (x: $0[0], y: $0[1]) : nil } ?? (sideways ? (x: 1.0, y: 0.0) : (x: 0.0, y: 1.0))
  // The plan, split into flings: each a cumulative distance over time.
  struct Point { var ms: Double; var total: Double; var phase: String }
  var flings: [[Point]] = []
  for step in steps where step.count == 3 {
    guard let ms = step[0] as? Double, let d = step[1] as? Double, let name = step[2] as? String else { continue }
    if name == "began" || flings.isEmpty { flings.append([]) }
    let before = flings[flings.count - 1].last?.total ?? 0
    flings[flings.count - 1].append(Point(ms: ms, total: before + d, phase: name))
  }
  let vsync = VSync(at: p)
  var carry = (x: 0.0, y: 0.0)
  func post(_ d: Double, _ name: String) {
    guard let (phase, momentum) = SCROLL_PHASE[name] else { return }
    carry.x += d * along.x
    carry.y += d * along.y
    let px = carry.x.rounded(.towardZero), py = carry.y.rounded(.towardZero)
    carry.x -= px
    carry.y -= py
    // Positive goes down (or right along) the page; a wheel delta goes the other way.
    guard let e = CGEvent(scrollWheelEvent2Source: source, units: .pixel, wheelCount: 2, wheel1: Int32(-py), wheel2: Int32(-px), wheel3: 0) else { return }
    e.flags = flags
    e.location = p
    e.setIntegerValueField(.scrollWheelEventIsContinuous, value: 1)
    // The exact (fractional) distance too: apps that read it scroll by fractions of a point when slow.
    e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis1, value: -d * along.y)
    e.setDoubleValueField(.scrollWheelEventFixedPtDeltaAxis2, value: -d * along.x)
    e.setIntegerValueField(.scrollWheelEventScrollPhase, value: phase)
    e.setIntegerValueField(.scrollWheelEventMomentumPhase, value: momentum)
    e.post(tap: .cghidEventTap)
    log("scroll", ["x": p.x, "y": p.y, "dx": px, "dy": py, "phase": name, "mods": mods])
  }
  let start = nowNs()
  for fling in flings {
    guard let first = fling.first, let last = fling.last else { continue }
    waitUntil(start + UInt64(first.ms * 1e6))
    let flingStart = nowNs()
    let fingerEnd = (fling.first { $0.phase == "ended" } ?? last).ms - first.ms
    let end = last.ms - first.ms
    // The plan's cumulative distance at a time into the fling.
    func at(_ t: Double) -> Double {
      let ms = first.ms + t
      guard let i = fling.firstIndex(where: { $0.ms >= ms }) else { return last.total }
      if i == 0 { return fling[0].total }
      let a = fling[i - 1], b = fling[i]
      return a.total + (b.total - a.total) * (ms - a.ms) / max(b.ms - a.ms, 1e-6)
    }
    var sent = 0.0
    var stage = 0 // 0 not begun, 1 finger, 2 ended, 3 momentum
    while true {
      if let vsync { vsync.next() } else { usleep(8_333) }
      let t = Double(nowNs() - flingStart) / 1e6
      switch stage {
      case 0:
        let target = at(min(t, fingerEnd))
        post(target - sent, "began"); sent = target; stage = 1
      case 1 where t < fingerEnd:
        let target = at(t)
        post(target - sent, "changed"); sent = target
      case 1:
        let target = at(fingerEnd)
        post(target - sent, "ended"); sent = target; stage = 2
        if fingerEnd >= end { break }
      case 2:
        let target = at(min(t, end))
        post(target - sent, "momentum-began"); sent = target; stage = 3
      default:
        let target = at(min(t, end))
        if t >= end {
          // What rounding left, then the end of the momentum.
          post(last.total - sent, "momentum"); sent = last.total
          post(0, "momentum-ended")
        } else {
          post(target - sent, "momentum"); sent = target
        }
      }
      if stage == 2 && fingerEnd >= end { break }
      if stage == 3 && t >= end { break }
    }
  }
}

// Virtual key codes for keys that aren't text (and letters, for shortcuts; ANSI positions).
let KEYS: [String: CGKeyCode] = [
  "Return": 36, "Enter": 36, "Tab": 48, "Space": 49, "Backspace": 51, "Escape": 53, "Delete": 117,
  "ArrowLeft": 123, "ArrowRight": 124, "ArrowDown": 125, "ArrowUp": 126, "Home": 115, "End": 119, "PageUp": 116, "PageDown": 121,
  "a": 0, "s": 1, "d": 2, "f": 3, "h": 4, "g": 5, "z": 6, "x": 7, "c": 8, "v": 9, "b": 11, "q": 12, "w": 13, "e": 14, "r": 15,
  "y": 16, "t": 17, "1": 18, "2": 19, "3": 20, "4": 21, "6": 22, "5": 23, "9": 25, "7": 26, "8": 28, "0": 29, "o": 31, "u": 32,
  "i": 34, "p": 35, "l": 37, "j": 38, "k": 40, "n": 45, "m": 46, ",": 43, ".": 47, "/": 44, "]": 30, "[": 33, "=": 24, "-": 27,
]
let MODS: [String: CGEventFlags] = ["cmd": .maskCommand, "shift": .maskShift, "alt": .maskAlternate, "ctrl": .maskControl]

// ── native menus (Accessibility) ───────────────────

func ax<T>(_ el: AXUIElement, _ attr: String) -> T? {
  var v: CFTypeRef?
  guard AXUIElementCopyAttributeValue(el, attr as CFString, &v) == .success else { return nil }
  return v as? T
}

func axFrame(_ el: AXUIElement) -> CGRect? {
  guard let p: AXValue = ax(el, kAXPositionAttribute), let s: AXValue = ax(el, kAXSizeAttribute) else { return nil }
  var point = CGPoint.zero, size = CGSize.zero
  AXValueGetValue(p, .cgPoint, &point)
  AXValueGetValue(s, .cgSize, &size)
  return CGRect(origin: point, size: size)
}

/**
 * The items of the app's open menus. An open context menu isn't in the app's
 * accessibility tree, but it is on screen: ScreenCaptureKit lists it as one of
 * the app's windows above layer 0, and the element at a point inside it leads
 * up to its AXMenu, whose children are the items with their frames.
 */
func openMenuItems(pid: pid_t) async throws -> [[String: Any]] {
  let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
  let system = AXUIElementCreateSystemWide()
  var found: [[String: Any]] = []
  for w in content.windows where w.owningApplication?.processID == pid && w.windowLayer > 0 {
    var hit: AXUIElement?
    guard AXUIElementCopyElementAtPosition(system, Float(w.frame.midX), Float(w.frame.minY + min(20, w.frame.height / 2)), &hit) == .success, var el = hit else { continue }
    // Up to the menu.
    for _ in 0..<4 where (ax(el, kAXRoleAttribute) as String?) != kAXMenuRole {
      guard let parent: AXUIElement = ax(el, kAXParentAttribute) else { break }
      el = parent
    }
    guard (ax(el, kAXRoleAttribute) as String?) == kAXMenuRole else { continue }
    for item in (ax(el, kAXChildrenAttribute) as [AXUIElement]?) ?? [] {
      guard let f = axFrame(item), f.height > 0 else { continue }
      let title: String = ax(item, kAXTitleAttribute) ?? ""
      let enabled: Bool = ax(item, kAXEnabledAttribute) ?? true
      found.append(["title": title, "x": f.minX, "y": f.minY, "w": f.width, "h": f.height, "enabled": enabled])
    }
  }
  return found
}

/** The modifier keys themselves, so a shortcut is played like a keyboard: modifiers down, the key, modifiers up. */
let MOD_KEYS: [String: CGKeyCode] = ["cmd": 55, "shift": 56, "alt": 58, "ctrl": 59]

func key(_ name: String, mods: [String]) throws {
  guard let code = KEYS[name] else { throw NSError(domain: "tour", code: 1, userInfo: [NSLocalizedDescriptionKey: "unknown key \(name)"]) }
  var flags = CGEventFlags()
  for m in mods {
    flags.formUnion(MODS[m] ?? [])
    let e = CGEvent(keyboardEventSource: source, virtualKey: MOD_KEYS[m] ?? 55, keyDown: true)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    usleep(25_000)
  }
  for down in [true, false] {
    let e = CGEvent(keyboardEventSource: source, virtualKey: code, keyDown: down)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    usleep(down ? 70_000 : 25_000)
  }
  for m in mods.reversed() {
    flags.subtract(MODS[m] ?? [])
    let e = CGEvent(keyboardEventSource: source, virtualKey: MOD_KEYS[m] ?? 55, keyDown: false)
    e?.flags = flags
    e?.post(tap: .cghidEventTap)
    usleep(15_000)
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
    if ch == "\u{8}" {
      try? key("Backspace", mods: [])
      continue
    }
    let units = Array(String(ch).utf16)
    for down in [true, false] {
      let e = CGEvent(keyboardEventSource: source, virtualKey: 0, keyDown: down)
      // No modifiers: a shortcut before must not turn letters into commands.
      e?.flags = []
      e?.keyboardSetUnicodeString(stringLength: units.count, unicodeString: units)
      e?.post(tap: .cghidEventTap)
      if down { usleep(useconds_t(min(80_000, max(15_000, (i + 1 < delays.count ? delays[i + 1] : 50) * 550)))) }
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
      // As fast as the display refreshes (120 on ProMotion): capped at 60 the frames come
      // from a 120 Hz stream at uneven 16.7/25 ms steps, and the 60 fps video repeats a
      // frame at every 25 ms gap (a hitch). Post resamples to an even 60 by timestamp.
      let screenFps = NSScreen.screens.first { $0.frame.size == display.frame.size }?.maximumFramesPerSecond ?? 60
      let fps = msg["fps"] as? Int32 ?? Int32(max(60, screenFps))
      config.minimumFrameInterval = CMTime(value: 1, timescale: fps)
      config.showsCursor = false
      config.pixelFormat = kCVPixelFormatType_32BGRA
      config.queueDepth = 6
      config.colorSpaceName = CGColorSpace.sRGB
      let filter = SCContentFilter(display: display, including: [app], exceptingWindows: [])
      let rec = try Recorder(filter: filter, config: config, out: URL(fileURLWithPath: out))
      try await rec.stream.startCapture()
      recorder = rec
      watchCursor((msg["cursors"] as? String).map { URL(fileURLWithPath: $0) })
      reply(["ok": true, "width": config.width, "height": config.height, "scale": scale, "fps": fps, "now": nowNs()])
    case "window-still":
      guard let pid = msg["pid"] as? Int32, let out = msg["out"] as? String else { return reply(["ok": false, "error": "pid and out are needed"]) }
      let content = try await SCShareableContent.excludingDesktopWindows(true, onScreenWindowsOnly: true)
      guard let main = content.windows.filter({ $0.owningApplication?.processID == pid && $0.windowLayer == 0 }).max(by: { $0.frame.width * $0.frame.height < $1.frame.width * $1.frame.height }) else { return reply(["ok": false, "error": "no window"]) }
      let scale = Int(NSScreen.screens.first { $0.frame.intersects(main.frame) }?.backingScaleFactor ?? 2)
      let config = SCStreamConfiguration()
      config.ignoreShadowsSingleWindow = false
      config.showsCursor = false
      config.captureResolution = .best
      // Room for the shadow around the window.
      let pad = 100.0
      config.width = Int(main.frame.width + 2 * pad) * scale
      config.height = Int(main.frame.height + 2 * pad) * scale
      let image = try await SCScreenshotManager.captureImage(contentFilter: SCContentFilter(desktopIndependentWindow: main), configuration: config)
      guard let dest = CGImageDestinationCreateWithURL(URL(fileURLWithPath: out) as CFURL, UTType.png.identifier as CFString, 1, nil) else { return reply(["ok": false, "error": "can't write \(out)"]) }
      CGImageDestinationAddImage(dest, image, nil)
      CGImageDestinationFinalize(dest)
      reply(["ok": true, "frame": [main.frame.minX, main.frame.minY, main.frame.width, main.frame.height], "size": [image.width, image.height], "scale": scale])
    case "record-stop":
      guard let rec = recorder else { return reply(["ok": false, "error": "not recording"]) }
      recorder = nil
      watchCursor(nil)
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
      try scroll(at: CGPoint(x: msg["x"] as? Double ?? 0, y: msg["y"] as? Double ?? 0), msg["steps"] as? [[Any]] ?? [], sideways: msg["axis"] as? String == "x", dir: msg["dir"] as? [Double], mods: msg["mods"] as? [String] ?? [])
      reply(["ok": true])
    case "type":
      type(msg["text"] as? String ?? "", delays: msg["delays"] as? [Double] ?? [])
      reply(["ok": true])
    case "key":
      try key(msg["key"] as? String ?? "", mods: msg["mods"] as? [String] ?? [])
      reply(["ok": true])
    case "menu-items":
      guard let pid = msg["pid"] as? Int32 else { return reply(["ok": false, "error": "pid is needed"]) }
      reply(["ok": true, "items": try await openMenuItems(pid: pid)])
    case "log":
      let taken = eventsLock.withLock { () -> [[String: Any]] in
        defer { events = [] }
        return events
      }
      reply(["ok": true, "events": taken])
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
