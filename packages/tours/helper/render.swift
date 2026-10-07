// Renders a tour's video from a plan (post.ts writes it): every output frame
// composited on the GPU with Core Image at exact, fractional positions, so the
// camera glides and zooms without the whole-pixel steps ffmpeg's crop has.
//   tour-render <plan.json> <out.mp4>
// Per frame: the wallpaper, the window's real shadow, the recording (the frame
// the plan names) masked to the window's real shape, the cursor shape at its
// place, a click ring; then the camera's view of that, scaled (Lanczos) to the
// output. Constant frame rate, H.264.
// Build: swiftc -O render.swift -o tour-render

import AVFoundation
import CoreImage
import CoreVideo
import Foundation

struct Plan: Decodable {
  struct Placed: Decodable { let path: String; let x: Double; let y: Double }
  struct Cursor: Decodable { let path: String; let w: Double; let h: Double }
  let fps: Int
  let width: Int
  let height: Int
  let canvas: [Double] // w, h
  let video: String
  let window: [Double] // x, y, w, h: where the recording goes on the canvas
  let mask: String
  struct Box: Decodable { let path: String; let x: Double; let y: Double; let w: Double; let h: Double }
  /** The desk under the window, in canvas px (larger than the canvas: the camera may look past its edges). */
  let wallpaper: Box
  let shadow: Placed
  let cursors: [String: Cursor]
  let ring: String?
  /** Per frame: source seconds, camera x, y, w, h, cursor id (-1 none), cursor x, y (top-left), ring x, y, opacity (all canvas px, top-left origin). */
  let frames: [[Double]]
}

func fail(_ s: String) -> Never {
  FileHandle.standardError.write((s + "\n").data(using: .utf8)!)
  exit(1)
}

let args = CommandLine.arguments
guard args.count == 3 else { fail("usage: tour-render <plan.json> <out.mp4>") }
let plan: Plan
do { plan = try JSONDecoder().decode(Plan.self, from: Data(contentsOf: URL(fileURLWithPath: args[1]))) } catch { fail("plan: \(error)") }

let cw = plan.canvas[0], ch = plan.canvas[1]
let srgb = CGColorSpace(name: CGColorSpace.sRGB)!
let ctx = CIContext(options: [.workingColorSpace: srgb, .outputColorSpace: srgb, .cacheIntermediates: false])

func image(_ path: String) -> CIImage {
  guard let i = CIImage(contentsOf: URL(fileURLWithPath: path)) else { fail("can't read \(path)") }
  return i
}
/** Top-left canvas coordinates to Core Image's (origin bottom-left). */
func place(_ i: CIImage, x: Double, y: Double) -> CIImage {
  i.transformed(by: CGAffineTransform(translationX: x - i.extent.minX, y: ch - y - i.extent.height - i.extent.minY))
}
func scaled(_ i: CIImage, w: Double, h: Double) -> CIImage {
  i.transformed(by: CGAffineTransform(scaleX: w / i.extent.width, y: h / i.extent.height))
}

// The still parts. The desk goes on forever: past the wallpaper's own edges its edge pixels extend.
let wallpaper = place(scaled(image(plan.wallpaper.path), w: plan.wallpaper.w, h: plan.wallpaper.h), x: plan.wallpaper.x, y: plan.wallpaper.y).clampedToExtent()
let shadow = place(image(plan.shadow.path), x: plan.shadow.x, y: plan.shadow.y)
let background = shadow.composited(over: wallpaper)
let (wx, wy, ww, wh) = (plan.window[0], plan.window[1], plan.window[2], plan.window[3])
let mask = place(scaled(image(plan.mask), w: ww, h: wh), x: wx, y: wy)
var cursorImages: [Int: CIImage] = [:]
for (id, c) in plan.cursors { cursorImages[Int(id)!] = scaled(image(c.path), w: c.w, h: c.h) }
let ring = plan.ring.map { image($0) }

// The recording, read in order; each output frame shows the newest frame at its source time.
let asset = AVURLAsset(url: URL(fileURLWithPath: plan.video))
guard let track = asset.tracks(withMediaType: .video).first, let reader = try? AVAssetReader(asset: asset) else { fail("can't read \(plan.video)") }
let readerOut = AVAssetReaderTrackOutput(track: track, outputSettings: [kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA])
readerOut.alwaysCopiesSampleData = false
reader.add(readerOut)
reader.startReading()
var current: CIImage?
var pending: CMSampleBuffer? = readerOut.copyNextSampleBuffer()
func frame(at s: Double) -> CIImage? {
  while let p = pending, CMTimeGetSeconds(CMSampleBufferGetPresentationTimeStamp(p)) <= s + 1e-4 {
    if let buf = CMSampleBufferGetImageBuffer(p) { current = CIImage(cvImageBuffer: buf) }
    pending = readerOut.copyNextSampleBuffer()
  }
  if current == nil, let p = pending, let buf = CMSampleBufferGetImageBuffer(p) { current = CIImage(cvImageBuffer: buf) }
  return current
}

// The output.
let outURL = URL(fileURLWithPath: args[2])
try? FileManager.default.removeItem(at: outURL)
guard let writer = try? AVAssetWriter(outputURL: outURL, fileType: .mp4) else { fail("can't write \(args[2])") }
let bitrate = Int(Double(plan.width * plan.height) * Double(plan.fps) * 0.16)
let input = AVAssetWriterInput(mediaType: .video, outputSettings: [
  AVVideoCodecKey: AVVideoCodecType.h264,
  AVVideoWidthKey: plan.width,
  AVVideoHeightKey: plan.height,
  AVVideoColorPropertiesKey: [AVVideoColorPrimariesKey: AVVideoColorPrimaries_ITU_R_709_2, AVVideoTransferFunctionKey: AVVideoTransferFunction_ITU_R_709_2, AVVideoYCbCrMatrixKey: AVVideoYCbCrMatrix_ITU_R_709_2],
  AVVideoCompressionPropertiesKey: [AVVideoAverageBitRateKey: bitrate, AVVideoProfileLevelKey: AVVideoProfileLevelH264HighAutoLevel, AVVideoExpectedSourceFrameRateKey: plan.fps, AVVideoMaxKeyFrameIntervalKey: plan.fps * 2],
])
input.expectsMediaDataInRealTime = false
let adaptor = AVAssetWriterInputPixelBufferAdaptor(assetWriterInput: input, sourcePixelBufferAttributes: [
  kCVPixelBufferPixelFormatTypeKey as String: kCVPixelFormatType_32BGRA,
  kCVPixelBufferWidthKey as String: plan.width,
  kCVPixelBufferHeightKey as String: plan.height,
  kCVPixelBufferIOSurfacePropertiesKey as String: [:],
])
writer.add(input)
guard writer.startWriting() else { fail("writer: \(writer.error?.localizedDescription ?? "?")") }
writer.startSession(atSourceTime: .zero)

let outRect = CGRect(x: 0, y: 0, width: plan.width, height: plan.height)
for (n, f) in plan.frames.enumerated() {
  guard f.count >= 11 else { continue }
  autoreleasepool {
    var img = background
    if let v = frame(at: f[0]) {
      let video = place(scaled(v, w: ww, h: wh), x: wx, y: wy)
      img = video.applyingFilter("CIBlendWithMask", parameters: [kCIInputBackgroundImageKey: img, kCIInputMaskImageKey: mask])
    }
    if let r = ring, f[10] > 0 {
      let faded = r.applyingFilter("CIColorMatrix", parameters: ["inputAVector": CIVector(x: 0, y: 0, z: 0, w: f[10])])
      img = place(faded, x: f[8] - r.extent.width / 2, y: f[9] - r.extent.height / 2).composited(over: img)
    }
    if f[5] >= 0, let c = cursorImages[Int(f[5])] {
      img = place(c, x: f[6], y: f[7]).composited(over: img)
    }
    // The camera: its view of the canvas, scaled to the output (Lanczos for quality, fractional all the way).
    let (vx, vy, vw, vh) = (f[1], f[2], f[3], f[4])
    let view = img.cropped(to: CGRect(x: vx, y: ch - vy - vh, width: vw, height: vh))
      .transformed(by: CGAffineTransform(translationX: -vx, y: -(ch - vy - vh)))
    let k = Double(plan.width) / vw
    let out = view.applyingFilter("CILanczosScaleTransform", parameters: [kCIInputScaleKey: k, kCIInputAspectRatioKey: (Double(plan.height) / vh) / k])
      .cropped(to: outRect)
    while !input.isReadyForMoreMediaData { usleep(1000) }
    var pb: CVPixelBuffer?
    guard let pool = adaptor.pixelBufferPool, CVPixelBufferPoolCreatePixelBuffer(nil, pool, &pb) == kCVReturnSuccess, let pb else { fail("no pixel buffer") }
    ctx.render(out, to: pb, bounds: outRect, colorSpace: srgb)
    adaptor.append(pb, withPresentationTime: CMTime(value: CMTimeValue(n), timescale: CMTimeScale(plan.fps)))
  }
  if n % 300 == 0 { FileHandle.standardError.write("frame \(n)/\(plan.frames.count)\n".data(using: .utf8)!) }
}
input.markAsFinished()
let done = DispatchSemaphore(value: 0)
writer.finishWriting { done.signal() }
done.wait()
if writer.status != .completed { fail("writer: \(writer.error?.localizedDescription ?? "?")") }
print(args[2])
