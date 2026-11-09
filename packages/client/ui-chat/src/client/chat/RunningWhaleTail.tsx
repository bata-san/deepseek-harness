/** Running indicator for the Chat status: a vendor-neutral rotating arc. */
import css from './ChatView.module.css'

/**
 * Render the decorative running icon (an arc that rotates once per second).
 * @returns the indicator, hidden from the accessibility tree.
 */
export function RunningWhaleTail() {
  return (
    <span className={css.runningIcon} aria-hidden="true">
      <svg width="100%" height="100%" viewBox="0 0 16 16" fill="none">
        <circle cx="8" cy="8" r="5.5" stroke="currentColor" strokeOpacity={0.25} strokeWidth={1.5} />
        <path d="M8 2.5A5.5 5.5 0 0 1 13.5 8" stroke="currentColor" strokeWidth={1.5} strokeLinecap="round">
          <animateTransform attributeName="transform" type="rotate" from="0 8 8" to="360 8 8" dur="1s" repeatCount="indefinite" />
        </path>
      </svg>
    </span>
  )
}
