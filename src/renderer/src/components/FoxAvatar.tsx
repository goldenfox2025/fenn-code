import { foxHead, foxCheeks, foxEarLeft, foxEarRight, foxNose } from './foxGeometry'

/** Rounded fennec identity. Outline is the user; solid is the assistant. */
export function FoxAvatar({ size = 24, variant = 'user', animated = false, className = '' }: {
  size?: number
  variant?: 'user' | 'assistant'
  animated?: boolean
  className?: string
}) {
  return <svg width={size} height={size} viewBox="0 0 64 64" fill="none" aria-hidden="true"
    className={`fox-avatar fox-${variant}${animated ? ' is-alive' : ''} ${className}`}>
    <path className="fox-head" d={foxHead} />
    <path className="fox-ear fox-ear-left" d={foxEarLeft} />
    <path className="fox-ear fox-ear-right" d={foxEarRight} />
    {variant === 'assistant' && <path className="fox-cheeks" d={foxCheeks} />}
    <g className="fox-eyes"><circle cx="23" cy="37" r="1.9" /><circle cx="41" cy="37" r="1.9" /></g>
    <path className="fox-nose" d={foxNose} />
  </svg>
}
