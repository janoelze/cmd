// Picture: an image, two ways. Without a `size` it is the Image window's: an <img> in a
// Viewport, a checkerboard behind its transparent parts, its pixels squares when `crisp`. With a
// `size` it is a picture in a box of its own (a cover, a thumbnail, a logo; the widget API's
// Picture, Now Playing's cover): that wide (or, "fill", as large as its parent's room allows at
// its `ratio`), cropped or fitted (`fit`), rounded (`radius`), and while there is no src, it is
// loading or it failed, a placeholder in the chart track colour with an `icon` sized to the box.
// Styles: frame.css, "a picture in a box".

import type * as React from "react";
import { forwardRef, useState, type CSSProperties, type KeyboardEvent } from "react";
import { Icon } from "./icon.tsx";

export interface PictureProps extends Omit<React.ImgHTMLAttributes<HTMLImageElement>, "src"> {
  /** The image (a data: URL in a widget); none, or one that fails to load, shows the placeholder. */
  src?: string | null;
  /** The Image window, zoomed far in: its pixels drawn as squares. */
  crisp?: boolean;
  /** In a box: fills it, cropped (default), or fits inside it. */
  fit?: "cover" | "contain";
  /** In a box: width over height (default 1, square). */
  ratio?: number;
  /** Draws it in a box this wide (px), or "fill": as large as its parent's room allows at its ratio (its parent sizes it: a flex child that grows). Without one: the Image window's bare picture. */
  size?: number | "fill";
  /** In a box: its corners (default md). */
  radius?: "sm" | "md" | "none";
  /** In a box: an SF Symbol on the placeholder, large in a large box and small in a thumbnail. */
  icon?: string;
}

/**
 * An image: the Image window's, in a Viewport (no `size`), or in a box of its own (`size`)
 * with a placeholder while it has none: a cover above a player, a thumbnail at a row's start.
 */
export const Picture = forwardRef<HTMLImageElement, PictureProps>(function Picture({ src, crisp, fit, ratio, size, radius, icon, alt, onClick, className, style, ...rest }, ref) {
  // The src that failed to load: another src is tried afresh.
  const [failed, setFailed] = useState<string | null>(null);
  if (size === undefined) return <img ref={ref} className={["ui-picture", className].filter(Boolean).join(" ")} data-crisp={crisp || undefined} src={src ?? undefined} alt={alt} onClick={onClick} style={style} {...rest} />;
  const shown = src && failed !== src ? src : null;
  const box = { ...(size === "fill" ? {} : { "--pic-w": `${size}px` }), ...(ratio ? { "--pic-ratio": ratio } : {}), ...style } as CSSProperties;
  const press = onClick && {
    role: "button",
    tabIndex: 0,
    onClick: onClick as unknown as React.MouseEventHandler<HTMLSpanElement>,
    onKeyDown: (e: KeyboardEvent<HTMLSpanElement>) => (e.key === "Enter" || e.key === " ") && (e.preventDefault(), (onClick as unknown as (e: KeyboardEvent) => void)(e)),
  };
  return (
    <span className={["ui-pic", className].filter(Boolean).join(" ")} data-size={size === "fill" ? "fill" : undefined} data-fit={fit === "contain" ? "contain" : undefined} data-radius={radius && radius !== "md" ? radius : undefined} style={box} {...press}>
      <span className="ui-pic-box">
        {shown ? (
          <img ref={ref} src={shown} alt={alt} draggable={false} data-crisp={crisp || undefined} onError={() => setFailed(shown)} {...rest} />
        ) : (
          <span className="ui-pic-none" role="img" aria-label={alt}>
            {icon && (
              <>
                <Icon name={icon} size={40} weight="light" className="ui-pic-icon-lg" />
                <Icon name={icon} size={18} className="ui-pic-icon-md" />
                <Icon name={icon} size={12} className="ui-pic-icon-sm" />
              </>
            )}
          </span>
        )}
      </span>
    </span>
  );
});
