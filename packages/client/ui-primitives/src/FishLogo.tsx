import type { IconProps } from './icons/props.ts'

/** Native viewBox of {@link FISH_LOGO_PATH} (width and height in user units); the vendor-neutral fork draws an H mark in it. */
export const FISH_LOGO_VIEWBOX = { width: 23.16, height: 17.04 }

/** The fish silhouette path data, exported for consumers that compose their own svg (entrance effects, masks) around the same geometry. */
export const FISH_LOGO_PATH = 'M7.08 0H16.08A4 4 0 0 1 20.08 4V13.04A4 4 0 0 1 16.08 17.04H7.08A4 4 0 0 1 3.08 13.04V4A4 4 0 0 1 7.08 0ZM7.6 13.54L9.4 13.54L9.4 9.42L13.76 9.42L13.76 13.54L15.56 13.54L15.56 3.5L13.76 3.5L13.76 7.62L9.4 7.62L9.4 3.5L7.6 3.5Z'

/**
 * Render the fish logo.
 * @param props.size - width in px (default 24; height keeps the 23.16:17.04 ratio).
 * @param props.className - extra class for layout placement.
 * @returns the logo svg (aria-hidden; pair with the wordmark for accessibility).
 */
export function FishLogo({ size = 24, className }: IconProps) {
  return (
    <svg
      width={size}
      height={(size * FISH_LOGO_VIEWBOX.height) / FISH_LOGO_VIEWBOX.width}
      className={className}
      viewBox={`0 0 ${FISH_LOGO_VIEWBOX.width} ${FISH_LOGO_VIEWBOX.height}`}
      fill="none"
      aria-hidden="true"
    >
      <path d={FISH_LOGO_PATH} fill="currentColor" />
    </svg>
  )
}
