// sfsymbols: renders SF Symbols natively at an exact point size and scale, so
// the UI can show them 1:1 (crisp, with the optical sizing macOS applies at
// small sizes) instead of downscaling one large bitmap.
//
//   sfsymbols <pointSize> <weight> <scale> <name>...
//   → {"<name>": {"png": "<base64>", "w": <points>, "h": <points>}, …}
//
// Each symbol is drawn centred in a canvas whose width and height are each
// rounded up to an even number of whole points (19.2×12.1 → 20×14), so icon
// buttons with even sizes centre it on whole pixels.
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
  guard pw > 0, ph > 0,
        let rep = NSBitmapImageRep(
          bitmapDataPlanes: nil, pixelsWide: pw, pixelsHigh: ph, bitsPerSample: 8, samplesPerPixel: 4,
          hasAlpha: true, isPlanar: false, colorSpaceName: .deviceRGB, bytesPerRow: 0, bitsPerPixel: 0)
  else { continue }
  // Points of the bitmap = its pixel size / scale, so drawing in points fills it exactly.
  let pointSize = NSSize(width: CGFloat(pw) / CGFloat(scale), height: CGFloat(ph) / CGFloat(scale))
  rep.size = pointSize
  NSGraphicsContext.saveGraphicsState()
  NSGraphicsContext.current = NSGraphicsContext(bitmapImageRep: rep)
  // Centre, but snapped to whole device pixels: a fractional offset puts every
  // stroke between pixels and blurs it (what native AppKit buttons avoid too).
  let snap = { (v: CGFloat) -> CGFloat in (v * CGFloat(scale)).rounded() / CGFloat(scale) }
  let origin = NSPoint(x: snap((pointSize.width - size.width) / 2), y: snap((pointSize.height - size.height) / 2))
  image.draw(in: NSRect(origin: origin, size: size))
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { continue }
  out[name] = ["png": png.base64EncodedString(), "w": pointSize.width, "h": pointSize.height]
}
let data = try JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
