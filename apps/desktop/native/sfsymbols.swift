// sfsymbols: renders SF Symbols natively at an exact point size and scale, so
// the UI can show them 1:1 (crisp, with the optical sizing macOS applies at
// small sizes) instead of downscaling one large bitmap.
//
//   sfsymbols <pointSize> <weight> <scale> <name>...
//   → {"<name>": {"png": "<base64>", "w": <points>, "h": <points>}, …}
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
  let pw = Int((size.width * CGFloat(scale)).rounded(.up))
  let ph = Int((size.height * CGFloat(scale)).rounded(.up))
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
  image.draw(in: NSRect(origin: .zero, size: pointSize))
  NSGraphicsContext.restoreGraphicsState()
  guard let png = rep.representation(using: .png, properties: [:]) else { continue }
  out[name] = ["png": png.base64EncodedString(), "w": pointSize.width, "h": pointSize.height]
}
let data = try JSONSerialization.data(withJSONObject: out)
FileHandle.standardOutput.write(data)
