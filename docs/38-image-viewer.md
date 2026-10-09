# Image viewer

> Status (2026-10-09): **built** on branch `image`, the MVP below. Not yet: HEIC (Chromium can't decode it; `sips` on macOS could convert), rotation, a slideshow, thumbnails, metadata, pausing an animated GIF.

A window that shows an image: fit to the window or zoomed, with the folder's other images a key away. Read first: this doc, docs/09-window-types.md, the PDF window it copies the toolbar and zoom from (`renderer/src/components/PdfView.tsx`), and the JSON window for live reload (docs/35-json-viewer.md).

## What the field calls an MVP, and the foot guns

The minimal viewers (qView, nsxiv, feh, macOS Preview) agree on the set: the image and nothing else, fit on open, zoom, actual size, pan, and next or previous image in the folder from the keyboard. Everything else (rotation, crop, slideshows, metadata panels, editing) is what the full ones add.

What viewers get wrong, and what this one does about it:

- **SVG with scripts.** Opened as a document, an SVG runs its scripts. Until now an SVG opened in the Browser window's webview, which does exactly that. In an `<img>` scripts never run, so that is how the Image window shows one; ⌘E shows the source in the editor.
- **Blurry at 100%.** A Retina display draws a CSS pixel as four device pixels, so an image at CSS size 1:1 is upscaled 2×. Actual Size here means one image pixel per device pixel (`width = naturalWidth / devicePixelRatio`), so a screenshot is sharp. An SVG's unit is a CSS pixel, so for it the density is 1.
- **Smoothed pixels when zoomed in.** From 200% up the image gets `image-rendering: pixelated`: a 16×16 icon at 1600% is squares, not a blur.
- **The checkerboard that swims.** The transparency checkerboard sits behind the picture only (not the whole view), in fixed 16px cells that don't scale with the zoom; VS Code had the scaling bug.
- **EXIF orientation and colour profiles.** Chromium applies both when drawing an `<img>` (`image-orientation: from-image` is the default). The file is shown unmodified and never re-encoded, so nothing to do; rotation controls would have to compose with it, one reason they're left out.
- **Huge images.** A 50-megapixel photo decodes to 200 MB; Chromium has dropped very large decodes silently in the past. The `<img>`'s error event lands in an honest empty state with Open with Default App. A 12,000 × 9,000 PNG decodes fine (see Stress).
- **Formats.** PNG, JPEG, GIF, WebP, AVIF, BMP, ICO and SVG decode in Chromium 132. HEIC, TIFF, PSD and RAW don't: they aren't routed here, and a misnamed file gets the error state. Animated GIF and WebP play on their own.
- **Local bytes.** The `cmd-file://` scheme already serves whitelisted image types read-only to the app's own pages (Markdown images, PDFs), and the renderer's CSP allows `img-src cmd-file:`. The `<img>` loads with `crossOrigin="anonymous"` (the scheme answers with CORS headers), so Copy Image can draw it to a canvas without tainting it.

## What it does

- **Routing**: png, jpg, jpeg, gif, webp, avif, bmp, ico and svg open in an **Image** window (`imageType`, priority over the browser, which keeps the same extensions so `open.handlers` can send them back: `png: browser`).
- **Fit** on open: the largest scale that shows the whole image, never past actual size (a 32px icon stays 32 device pixels; zoom if you want it bigger). Fit follows the window as it resizes.
- **Zoom**: a pinch (a wheel event with ctrlKey) around the cursor; ⌘+ ⌘− step through 5%…6400% around the view's centre; ⌘0 is Actual Size; the toolbar's menu has Fit, Actual Size and presets; double-click flips Fit ⇄ Actual Size at the cursor. Zooming keeps the point under the cursor still: the image's fraction under the cursor is noted before, and the scroll position set after layout. The zoom is window state (`zoom: "fit" | number`), so it survives a reload.
- **Pan**: scrollbars, or drag when the image is larger than the view (a grab cursor says so).
- **← →** (Home, End) walk the folder's images by name (`fs.list`, filtered by extension, natural sort); the toolbar says "3 of 41" and has Previous and Next.
- **Status**: "4032 × 3024 · 2.1 MB · JPEG". Menu: Fit, Actual Size, Edit Source (⌘E, SVG only), Copy Image, Copy Path, Open with Default App, Show in Finder. Right-click the picture for the copy and open entries.
- **Copy Image** draws the picture to a canvas and puts a PNG on the clipboard (the clipboard takes PNG only; an SVG is rasterised at its size).
- **Live**: the file is watched; a change shows the new picture at the same zoom.
- **Errors**: a file that won't decode gets "Couldn't show this image" with Open with Default App.

## Under the hood

- **Core** (`windows/builtin.ts` `imageType`): `{ path, zoom? }`; `create` checks the file exists, `update` takes a new path (← →) or zoom, clamped to 1%…6400%. `IMAGE_EXTENSIONS` is exported for the test.
- **Renderer**: `windows/image.tsx` (registration, menu, `copyImageFile`, `registerPreview("image", /\.svg$/)`), `image-view.tsx` (the view), `image.css`. `preview.ts` now flips a preview window to text only for a file it previews, so ⌘E on a PNG does nothing instead of opening binary in the editor.
- Nothing new in the protocol or the kit: `fs.list`, `fs.watch`, `window.update`, the `WindowToolbar`, `EmptyState`, `Spinner`.

## Stress (2026-10-09)

See the driver's numbers in the commit that built this: a 12,000 × 9,000 PNG (108 megapixels, 14 MB) opens and fits; the 16 × 16 pixel-art PNG at 1600% draws crisp; an SVG with a `<script>` shows and nothing runs; a text file named `.png` lands in the error state; a change on disk shows within a second.

## Later

- HEIC through `sips -s format jpeg` in the main process, cached beside the app's state.
- Rotate (composing with the EXIF orientation), a slideshow, thumbnails of the folder.
- Pause and step an animated GIF.
- Pixel inspection: the colour under the cursor at high zoom.
