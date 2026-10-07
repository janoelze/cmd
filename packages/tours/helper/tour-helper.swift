// The tour helper: what a tour needs from macOS, driven by the Node driver as
// JSON lines on stdin, one reply line each on stdout.
//
//   {"cmd":"record-start","pid":123,"out":"/x/raw.mov","rect":[x,y,w,h]?,"fps":60}
//       Records the display, showing only that app's windows (its context menus
//       and menu-bar menus included), cropped to `rect` (screen points), without
//       the system cursor: the cursor is drawn later from the event log.
//   {"cmd":"record-stop"}  → {"ok":true,"frames":n,"t0":ns,"t1":ns}
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
