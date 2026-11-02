import { cn } from "@/lib/utils";

/*
 * Copied from qdit (qdit/web/src/components/brand/qdit-mark.tsx) so the
 * Connected apps card can show qdit's own mark. Keep the geometry in step
 * with qdit's copy rather than editing it here.
 */

/**
 * The qdit mark — a continuous folded ribbon reading as an abstract lowercase
 * "q": a rounded body wrapped around an open rounded-triangle aperture, with a
 * tail sweeping out to the lower right.
 *
 * The geometry here is *traced* from `materials/icons.png` (the brand sheet),
 * not reconstructed from the spec prose. The ribbon is three stacked faces —
 * the fold underside, the right lobe + tail, and the top-left face — plus a
 * contact shadow where the top face crosses over the underside. Each face
 * carries its own gradient, fitted to the source pixels.
 *
 * Per the design spec this is never a checkmark or a clipboard, and the
 * aperture stays open.
 */

/** Full-detail geometry: base silhouette, mid layer (lobe + top), top face. */
const BASE = "M 18.65 0.1 C 18.59 0.18 18.41 0.23 17.77 0.35 C 15.5 0.77 13.71 1.49 12.32 2.55 C 11.83 2.91 3.06 11.7 2.73 12.14 C 1.64 13.63 0.89 15.53 0.65 17.46 C 0.59 17.97 0.57 18.03 0.47 18.07 C 0.38 18.1 0.36 26.1 0.45 26.1 C 0.55 26.1 0.61 26.32 0.65 26.86 C 0.88 29.48 1.9 32.55 3.17 34.43 C 3.37 34.73 3.83 35.41 4.19 35.95 C 6.33 39.14 9.57 41.54 12.88 42.37 C 14.66 42.81 14.27 42.8 26.75 42.8 C 36.09 42.8 37.82 42.81 37.96 42.86 C 38.05 42.9 38.43 43.19 38.8 43.5 C 39.57 44.14 41.01 45.12 42.18 45.8 C 42.62 46.05 43.23 46.41 43.55 46.6 C 44.85 47.36 46.02 47.95 46.24 47.95 C 46.43 47.95 47.04 47.6 47.2 47.4 C 47.3 47.28 47.43 47.13 47.49 47.07 C 47.63 46.91 47.66 46.09 47.52 45.95 C 47.48 45.91 47.29 45.59 47.1 45.25 C 46.92 44.91 46.44 44.04 46.05 43.33 C 45.66 42.61 45.12 41.63 44.86 41.15 C 44.39 40.28 43.62 38.87 42.3 36.48 C 41.92 35.79 41.45 34.92 41.25 34.55 C 41.05 34.18 40.76 33.65 40.6 33.38 C 39.96 32.28 40.03 33.35 40 24.3 C 39.97 16.32 39.97 16.32 39.84 15.54 C 39.24 12.05 37.47 8.75 35.05 6.63 C 34.75 6.36 34.29 5.89 34.02 5.59 C 31.25 2.4 28.75 0.99 24.65 0.3 C 24.18 0.22 24.01 0.17 23.94 0.1 C 23.81 -0.06 18.77 -0.05 18.65 0.1 M 21.32 12.52 C 20.02 12.77 20.35 12.46 11.82 21.18 C 9.3 23.75 11.91 29.07 16 29.7 C 16.99 29.86 27.05 29.85 27.2 29.7 C 27.36 29.54 27.36 17.52 27.2 16.73 C 26.62 13.91 23.97 12.02 21.32 12.52";
const MID = "M 15.67 0.08 C 15.65 0.12 15.39 0.23 15.11 0.33 C 14.55 0.52 13.18 1.18 12.9 1.4 C 12.8 1.47 12.65 1.57 12.56 1.62 C 12.34 1.73 2.13 11.95 2 12.19 C 1.9 12.37 1.71 12.66 1.41 13.08 C 1.2 13.37 0.88 14.03 0.78 14.37 C 0.73 14.55 0.63 14.72 0.55 14.81 C 0.37 14.99 0.3 29.99 0.48 30.12 C 0.52 30.15 0.68 30.54 0.83 30.99 C 0.98 31.44 1.16 31.91 1.22 32.04 C 1.29 32.17 1.37 32.38 1.4 32.5 C 1.47 32.77 2.04 33.88 2.27 34.23 C 2.97 35.23 3.08 35.26 3.51 34.61 C 3.72 34.29 3.72 34.29 3.73 33.33 C 3.75 31.38 4.45 29.46 5.74 27.83 C 6.42 26.97 7.38 25.86 8.1 25.1 C 8.53 24.65 9.1 24.03 9.36 23.73 C 10.53 22.37 10.82 22.22 10.83 22.97 C 10.83 23.37 10.84 23.42 10.95 23.51 C 11.2 23.71 11.6 23.53 11.6 23.2 C 11.6 23.12 11.64 22.94 11.7 22.8 C 11.75 22.66 11.8 22.47 11.8 22.39 C 11.8 21.9 11.81 21.89 16.1 17.6 C 20.2 13.5 20.31 13.4 20.59 13.4 C 20.67 13.4 20.86 13.36 21 13.3 C 21.99 12.91 23.93 13.29 25.03 14.09 C 25.5 14.42 26.4 15.94 26.4 16.38 C 26.4 16.47 26.45 16.66 26.5 16.8 C 26.6 17.05 26.6 17.17 26.6 23.3 C 26.6 30.45 26.55 29.8 27.12 29.8 C 27.39 29.8 27.39 29.8 27.42 29.99 C 27.55 30.67 27.79 31.2 28.13 31.53 C 28.36 31.74 28.55 32.18 28.55 32.48 C 28.55 32.9 28.84 33.3 30 34.48 C 30.6 35.08 31.28 35.78 31.51 36.03 C 31.74 36.29 32.6 37.2 33.43 38.06 C 34.25 38.92 35.28 40 35.7 40.45 C 36.13 40.9 36.73 41.54 37.04 41.85 C 37.75 42.59 37.76 42.66 37.14 42.73 C 36.75 42.77 36.6 42.89 36.6 43.18 C 36.6 43.52 36.91 43.68 37.29 43.54 C 37.58 43.44 38.05 43.6 38.43 43.93 C 38.61 44.08 38.78 44.2 38.8 44.2 C 38.83 44.2 39.03 44.37 39.26 44.57 C 39.49 44.77 39.74 44.97 39.83 45.02 C 39.97 45.1 40.29 45.32 40.68 45.59 C 40.79 45.67 41.03 45.81 41.2 45.9 C 41.38 45.99 41.6 46.12 41.7 46.2 C 41.8 46.28 42.02 46.41 42.2 46.5 C 42.38 46.59 42.6 46.72 42.7 46.8 C 42.8 46.88 43.11 47.06 43.4 47.2 C 43.91 47.46 44.5 47.86 44.5 47.95 C 44.5 48.03 47.47 48.01 47.54 47.94 C 47.66 47.82 47.62 44.74 47.5 44.66 C 47.45 44.63 47.21 44.21 46.97 43.74 C 46.73 43.26 46.48 42.8 46.4 42.7 C 46.32 42.6 46.1 42.2 45.9 41.8 C 45.7 41.4 45.48 41 45.4 40.9 C 45.32 40.8 45.05 40.31 44.8 39.8 C 44.55 39.29 44.28 38.8 44.2 38.7 C 44.12 38.6 43.85 38.11 43.6 37.6 C 43.35 37.09 43.08 36.6 43 36.5 C 42.92 36.4 42.65 35.91 42.4 35.4 C 42.15 34.89 41.87 34.4 41.8 34.3 C 41.57 34 40.8 32.41 40.8 32.22 C 40.8 32.13 40.76 31.94 40.7 31.8 C 40.57 31.47 40.57 31.13 40.71 30.78 C 40.81 30.5 40.81 30.5 40.71 30.22 C 40.6 29.94 40.6 29.94 40.6 22.8 C 40.6 15.77 40.6 15.65 40.5 15.4 C 40.45 15.26 40.4 15.04 40.4 14.9 C 40.4 14.76 40.36 14.54 40.3 14.4 C 40.24 14.26 40.2 14.09 40.2 14.02 C 40.2 13.66 39.69 12.37 39 11.01 C 38.29 9.6 38.14 9.35 37.71 8.83 C 37.58 8.66 37.43 8.46 37.39 8.38 C 37.34 8.29 36.63 7.54 35.8 6.7 C 34.97 5.86 34.25 5.09 34.2 5 C 34.09 4.78 32.04 2.73 31.83 2.61 C 31.74 2.57 31.54 2.42 31.38 2.29 C 30.86 1.87 30.61 1.72 29.38 1.1 C 28.24 0.52 27.46 0.2 27.18 0.2 C 27.11 0.2 27.01 0.16 26.95 0.1 C 26.81 -0.04 15.76 -0.06 15.67 0.08";
const TOP = "M 15.67 0.08 C 15.65 0.12 15.39 0.23 15.11 0.33 C 14.55 0.52 13.18 1.18 12.9 1.4 C 12.8 1.47 12.65 1.57 12.56 1.62 C 12.34 1.73 2.13 11.95 2 12.19 C 1.9 12.37 1.71 12.66 1.41 13.08 C 1.2 13.37 0.88 14.03 0.78 14.37 C 0.73 14.55 0.63 14.72 0.55 14.81 C 0.37 14.99 0.3 29.99 0.48 30.12 C 0.52 30.15 0.68 30.54 0.83 30.99 C 0.98 31.44 1.16 31.91 1.22 32.04 C 1.29 32.17 1.37 32.38 1.4 32.5 C 1.47 32.77 2.04 33.88 2.27 34.23 C 2.97 35.23 3.08 35.26 3.51 34.61 C 3.72 34.29 3.72 34.29 3.73 33.33 C 3.75 31.38 4.45 29.46 5.74 27.83 C 6.42 26.97 7.38 25.86 8.1 25.1 C 8.53 24.65 9.1 24.03 9.36 23.73 C 10.53 22.37 10.82 22.22 10.83 22.97 C 10.83 23.37 10.84 23.42 10.95 23.51 C 11.2 23.71 11.6 23.53 11.6 23.2 C 11.6 23.12 11.64 22.94 11.7 22.8 C 11.75 22.66 11.8 22.47 11.8 22.39 C 11.8 21.9 11.81 21.89 16.1 17.6 C 20.2 13.5 20.31 13.4 20.59 13.4 C 20.67 13.4 20.86 13.36 21 13.3 C 21.14 13.24 21.32 13.2 21.4 13.2 C 21.75 13.2 21.92 12.77 21.67 12.52 C 21.53 12.38 21.56 12.38 20.94 12.48 C 20.43 12.56 20.58 12.36 22.22 10.73 C 27.46 5.52 29.72 4.43 33.06 5.53 C 33.57 5.7 34.15 5.41 34.15 5 C 34.15 4.84 32.15 2.79 31.82 2.61 C 31.74 2.57 31.54 2.42 31.38 2.29 C 30.86 1.87 30.61 1.72 29.38 1.1 C 28.24 0.52 27.46 0.2 27.18 0.2 C 27.11 0.2 27.01 0.16 26.95 0.1 C 26.81 -0.04 15.76 -0.06 15.67 0.08";

/**
 * Small-size geometry: one silhouette, aperture and outline outset by ~0.8/1.6
 * source px so both stay open below ~24px, where the full mark closes up.
 */
const SIMPLE = "M 18.54 0.03 C 18.53 0.04 18.16 0.12 17.72 0.2 C 15.45 0.62 13.66 1.34 12.27 2.4 C 11.78 2.76 2.91 11.65 2.58 12.09 C 1.49 13.58 0.79 15.35 0.49 17.43 C 0.4 18.06 0.4 26.06 0.49 26.9 C 0.8 29.75 1.75 32.6 3.02 34.48 C 3.22 34.78 3.68 35.46 4.04 36 C 6.21 39.24 9.51 41.69 12.83 42.52 C 14.6 42.96 14.21 42.95 26.7 42.95 C 35.98 42.95 37.77 42.96 37.91 43.02 C 38 43.05 38.38 43.34 38.75 43.65 C 39.52 44.29 40.96 45.27 42.13 45.95 C 42.56 46.2 43.18 46.56 43.5 46.75 C 45.97 48.2 46.55 48.32 47.26 47.57 C 47.6 47.2 47.6 47.19 47.6 46.48 C 47.6 45.74 47.78 46.15 46.2 43.28 C 45.81 42.56 45.27 41.58 45.01 41.1 C 44.54 40.23 43.77 38.82 42.45 36.43 C 42.07 35.74 41.6 34.87 41.4 34.5 C 41.2 34.13 40.91 33.6 40.75 33.33 C 40.11 32.23 40.18 33.3 40.15 24.25 C 40.12 16.28 40.12 16.28 39.99 15.49 C 39.39 11.97 37.58 8.63 35.1 6.48 C 34.83 6.24 34.41 5.82 34.17 5.53 C 31.34 2.25 28.98 0.92 24.46 0.1 C 23.92 0 18.63 -0.06 18.54 0.03 M 20.9 12.4 C 20.78 12.45 20.6 12.5 20.5 12.5 C 20.19 12.5 20.05 12.64 15.59 17.09 C 10.87 21.81 10.9 21.78 10.9 22.29 C 10.9 22.37 10.85 22.56 10.8 22.7 C 10.66 23.07 10.66 24.13 10.8 24.5 C 10.85 24.64 10.9 24.86 10.9 24.98 C 10.9 26.65 13.04 29.04 15.15 29.75 C 16 30.04 26.99 29.97 27.28 29.68 C 27.54 29.43 27.65 17.32 27.4 16.7 C 27.34 16.56 27.3 16.37 27.3 16.28 C 27.3 15.84 26.45 14.41 25.82 13.78 C 24.57 12.53 22.19 11.86 20.9 12.4";

type MarkProps = {
  className?: string;
  /** Flat single-colour rendering. Use inside dense UI; gradient is branding-only. */
  flat?: boolean;
  title?: string;
};

export function QditMark({ className, flat = false, title }: MarkProps) {
  // SVG ids are document-scoped, so repeated marks emit duplicate ids. That is
  // harmless here: every instance defines the *same* gradients and clip path, so
  // a browser resolving to the first match renders identically either way.
  const uid = "qdit";

  return (
    <svg
      viewBox="0 0 48 48"
      fill="none"
      role={title ? "img" : "presentation"}
      aria-hidden={title ? undefined : true}
      aria-label={title}
      className={cn("size-8", className)}
    >
      {title ? <title>{title}</title> : null}

      {flat ? (
        <path fill="currentColor" fillRule="evenodd" clipRule="evenodd" d={SIMPLE} />
      ) : (
        <>
          <defs>
            <linearGradient id={`${uid}-gb`} x1="6.62" y1="27.32" x2="33.19" y2="46.62" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#2B24A7"/><stop offset="0.304" stopColor="#624AEC"/><stop offset="0.435" stopColor="#6E53F8"/><stop offset="0.609" stopColor="#5E47E8"/><stop offset="0.87" stopColor="#3B2FBD"/><stop offset="0.957" stopColor="#382CB6"/><stop offset="1" stopColor="#382BAE"/></linearGradient>
            <linearGradient id={`${uid}-gr`} x1="23.15" y1="9.98" x2="50.07" y2="44.44" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#4436D2"/><stop offset="0.13" stopColor="#5342EB"/><stop offset="0.217" stopColor="#5E4EF3"/><stop offset="0.348" stopColor="#6557F4"/><stop offset="0.565" stopColor="#6253F4"/><stop offset="0.826" stopColor="#685CF3"/><stop offset="0.957" stopColor="#7165F4"/><stop offset="1" stopColor="#756BF5"/></linearGradient>
            <linearGradient id={`${uid}-gg`} x1="25.5" y1="-1.87" x2="-2.01" y2="28.67" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#6C55F6"/><stop offset="0.261" stopColor="#6046E7"/><stop offset="0.391" stopColor="#8663F6"/><stop offset="0.435" stopColor="#8866F7"/><stop offset="0.565" stopColor="#7E5FF7"/><stop offset="0.739" stopColor="#654EF7"/><stop offset="0.913" stopColor="#6450F7"/><stop offset="1" stopColor="#5F49FA"/></linearGradient>
            <linearGradient id={`${uid}-gsh`} x1="11.47" y1="42.66" x2="24.44" y2="28.26" gradientUnits="userSpaceOnUse"><stop offset="0" stopColor="#27229D" stopOpacity={0.094}/><stop offset="0.348" stopColor="#27229D" stopOpacity={0.106}/><stop offset="0.565" stopColor="#27229D" stopOpacity={0.209}/><stop offset="0.609" stopColor="#27229D" stopOpacity={0.205}/><stop offset="0.739" stopColor="#27229D" stopOpacity={0.333}/><stop offset="0.87" stopColor="#27229D" stopOpacity={0.555}/><stop offset="1" stopColor="#27229D" stopOpacity={0.67}/></linearGradient>
            <clipPath id={`${uid}-clip`}>
              <path clipRule="evenodd" d={BASE} />
            </clipPath>
          </defs>

          <g clipPath={`url(#${uid}-clip)`}>
            <path fill={`url(#${uid}-gb)`} fillRule="evenodd" d={BASE} />
            {/* Contact shadow where the top face crosses the fold underside. */}
            <rect width="48" height="48" fill={`url(#${uid}-gsh)`} />
            <path fill={`url(#${uid}-gr)`} fillRule="evenodd" d={MID} />
            <path fill={`url(#${uid}-gg)`} fillRule="evenodd" d={TOP} />
          </g>
        </>
      )}
    </svg>
  );
}
