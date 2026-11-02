import { cn } from "@/lib/utils";

/*
 * The Varial wallet mark (Freighter's new name). Traced from Varial's app
 * icon: a curved blade reading as the left stroke of a "V", and a four-point
 * sparkle above its open side. Geometry is in the icon's own 240-unit grid.
 */

/** The blade: a straight inner edge and a convex outer arc, rounded at both tips. */
const BLADE =
  "M 49 65.5 C 93 71 125 112 128.5 162 C 129.5 176 129.5 185 128 191 C 127 196.5 121.5 197.5 119.5 193 L 46 76 C 43.5 71 44.5 65.5 49 65.5 Z";
/** The sparkle upright; SPARKLE_TILT turns it 14° clockwise, as on the icon. */
const SPARKLE = "M 157 47 Q 168 74 195 85 Q 168 96 157 123 Q 146 96 119 85 Q 146 74 157 47 Z";
const SPARKLE_TILT = "rotate(14 157 85)";

/** Varial's brand blue, sampled from the icon. */
export const VARIAL_BLUE = "#0B4BFF";

type MarkProps = {
  className?: string;
  /**
   * Just the glyph in currentColor, no blue tile. Use inline with text, where
   * a coloured tile would shout.
   */
  flat?: boolean;
  title?: string;
};

export function VarialMark({ className, flat = false, title }: MarkProps) {
  const glyph = (
    // A round-joined stroke in the fill colour softens every tip, as on the icon.
    <g fill={flat ? "currentColor" : "#fff"} stroke={flat ? "currentColor" : "#fff"} strokeWidth={4} strokeLinejoin="round">
      <path d={BLADE} />
      <path d={SPARKLE} transform={SPARKLE_TILT} />
    </g>
  );

  return (
    <svg
      // The flat glyph is cropped to its own bounds so it sits like an icon.
      viewBox={flat ? "36 37 170 170" : "0 0 240 240"}
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={cn("size-8", className)}
    >
      {title ? <title>{title}</title> : null}
      {flat ? null : (
        <>
          <rect width="240" height="240" rx="56" fill={VARIAL_BLUE} />
          {/* A faint inner rim so the tile sits with the glass surfaces around it. */}
          <rect x="2" y="2" width="236" height="236" rx="54" fill="none" stroke="#fff" strokeOpacity={0.14} strokeWidth={4} />
        </>
      )}
      {glyph}
    </svg>
  );
}
