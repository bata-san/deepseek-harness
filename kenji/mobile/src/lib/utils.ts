import { type ClassValue, clsx } from 'clsx'
import { twMerge } from 'tailwind-merge'

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

const rtf = new Intl.RelativeTimeFormat('ja', { numeric: 'auto' })

/** 「3 分前」のような相対時刻 */
export function relativeTime(epochMs: number): string {
  const diff = (epochMs - Date.now()) / 1000
  const abs = Math.abs(diff)
  if (abs < 45) return 'たった今'
  if (abs < 3600) return rtf.format(Math.round(diff / 60), 'minute')
  if (abs < 86400) return rtf.format(Math.round(diff / 3600), 'hour')
  if (abs < 86400 * 7) return rtf.format(Math.round(diff / 86400), 'day')
  return new Date(epochMs).toLocaleDateString('ja-JP', { month: 'short', day: 'numeric' })
}

export function shortPath(path: string | undefined, home = ''): string {
  if (!path) return ''
  let out = path
  if (home && out.toLowerCase().startsWith(home.toLowerCase())) out = `~${out.slice(home.length)}`
  const parts = out.split(/[\\/]/).filter(Boolean)
  return parts.length > 3 ? `…/${parts.slice(-2).join('/')}` : out
}

export function vibrate(ms = 10) {
  try { navigator.vibrate?.(ms) } catch { /* 非対応端末 */ }
}
