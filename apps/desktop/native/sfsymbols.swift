// sfsymbols: renders SF Symbols natively at an exact point size and scale, so
// the UI can show them 1:1 (crisp, with the optical sizing macOS applies at
// small sizes) instead of downscaling one large bitmap.
//
//   sfsymbols <pointSize> <weight> <scale> <name>...
//   → {"<name>": {"png": "<base64>", "w": <points>, "h": <points>}, …}
//
// Each symbol is drawn centred in a canvas whose width and height are each
// rounded up to an even number of whole points (19.2×12.1 → 20×14), so icon
// buttons with even sizes centre it on whole pixels. Within that, it is nudged by
// up to half a device pixel on each axis to wherever its strokes land on whole
// pixels (the least antialiased coverage), like hinting: a stroke centred on a
// pixel boundary would otherwise smear over two half-lit pixels.
//
// Template symbols draw black on transparent; the UI tints them via CSS masks.

import AppKit

let args = CommandLine.arguments
guard args.count >= 5, let pt = Double(args[1]), let scale = Double(args[3]) else {
  FileHandle.standardError.write("usage: sfsymbols <pointSize> <weight> <scale> <name>...\n".data(using: .utf8)!)
  exit(2)
}
let weights: [String: NSFont.Weight] = [
  "ultralight": .ultraLight, "thin": .thin, "light": .light, "regular": .regular,
  "medium": .medium, "semibold": .semibold, "bold": .bold, "heavy": .heavy,
]
let config = NSImage.SymbolConfiguration(pointSize: CGFloat(pt), weight: weights[args[2]] ?? .regular)

var out: [String: [String: Any]] = [:]
for name in args.dropFirst(4) {
  guard let base = NSImage(systemSymbolName: name, accessibilityDescription: nil),
        let image = base.withSymbolConfiguration(config) else { continue }
  let size = image.size
  let even = { (v: CGFloat) -> Int in let n = Int(v.rounded(.up)); return n % 2 == 0 ? n : n + 1 }
  let pw = even(size.width) * Int(scale)
  let ph = even(size.height) * Int(scale)
  guard pw > 0, ph > 0 else { continue }
  // Points of the bitmap = its pixel size / scale, so drawing in points fills it exactly.
  let pointSize = NSSize(width: CGFloat(pw) / CGFloat(scale), height: CGFloat(ph) / CGFloat(scale))
  // Centre, snapped to whole device pixels (what native AppKit buttons do too)…
  let snap = { (v: CGFloat) -> CGFloat in (v * CGFloat(scale)).rounded() / CGFloat(scale) }
  let centre = NSPoint(x: snap((pointSize.width - size.width) / 2), y: snap((pointSize.height - size.height) / 2))
  // …then the nudge with the crispest strokes. AppKit snaps symbol drawing to whole
  // pixels (an offset origin or transform changes nothing), so each candidate is drawn
  // at 4× and averaged down: a shift of whole 4× pixels is a true quarter-pixel one.
  let k = 4
  func draw(_ dx: Int, _ dy: Int) -> [UInt8]? {
    guard let hi = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pw * k, pixelsHigh: ph * k, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: pw * k * 4, bitsPerPixel: 32)
    else { return nil }
    hi.size = pointSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: hi)
    let step = 1 / (CGFloat(scale) * CGFloat(k))
    image.draw(in: NSRect(origin: NSPoint(x: centre.x + CGFloat(dx) * step, y: centre.y - CGFloat(dy) * step), size: size))
    NSGraphicsContext.restoreGraphicsState()
    guard let src = hi.bitmapData else { return nil }
    var alpha = [UInt8](repeating: 0, count: pw * ph)
    for y in 0..<ph {
      for x in 0..<pw {
        var sum = 0
        for j in 0..<k { for i in 0..<k { sum += Int(src[((y * k + j) * pw * k + x * k + i) * 4 + 3]) } }
        alpha[y * pw + x] = UInt8((sum + k * k / 2) / (k * k))
      }
    }
    return alpha
  }
  /** Drawn directly at the target size, centred (macOS's own rendering, a hair sharper than 4× averaged down). */
  func direct() -> [UInt8]? {
    guard let rep = NSBitmapImageRep(
      bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4,
      hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: pw * 4, bitsPerPixel: 32)
    else { return nil }
    rep.size = pointSize
    NSGraphicsContext.saveGraphicsState()
    NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
    image.draw(in: NSRect(origin: centre, size: size))
    NSGraphicsContext.restoreGraphicsState()
    guard let d = rep.bitmapData else { return nil }
    return (0..<(pw * ph)).map { d[$0 * 4 + 3] }
  }
  var best: (alpha: [UInt8], score: Int)? = nil
  let score = { (alpha: [UInt8]) in alpha.reduce(0) { $0 + min(Int($1), 255 - Int($1)) } }
  // The direct render first, so a nudge has to be crisper to win; then, in 4× pixels,
  // 0, ±¼ and ½ device pixel on each axis.
  if let alpha = direct() { best = (alpha, score(alpha)) }
  for dy in [0, 1, -1, 2] {
    for dx in [0, 1, -1, 2] {
      guard let alpha = draw(dx, dy) else { continue }
      // Partial coverage: how far each pixel is from fully on or off.
      let s = score(alpha)
      if best == nil || s < best!.score { best = (alpha, s) }
    }
  }
  guard let alpha = best?.alpha,
        let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4,
          hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: pw * 4, bitsPerPixel: 32),
        let pixels = rep.bitmapData
  else { continue }
  rep.size = pointSize
  // Black, premultiplied: the alpha is all the UI uses (a CSS mask).
  for i in 0..<(pw * ph) { pixels[i * 4] = 0; pixels[i * 4 + 1] = 0; pixels[i * 4 + 2] = 0; pixels[i * 4 + 3] = alpha[i] }
  guard let png = rep.representation(using: .png, properties: [:]) else { continue }
  out[name] = ["png": png.base64EncodedString(), "w": pointSize.width, "h": pointSize.height]
}
let data = try JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
