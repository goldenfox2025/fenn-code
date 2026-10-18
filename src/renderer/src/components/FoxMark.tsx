import { memo } from 'react'

/**
 * The thinking fox: the app icon's pixel fox with thought bubbles rising beside its head, small to large.
 * One 16×16 pixel grid drawn at a whole number of screen pixels per cell, centred on whole pixels,
 * so it stays crisp at every size it is offered in (20, 30, 36, 40 too, for 125% / 150% scaling). It takes the accent color.
 * `thinking` animates it while an agent works: the thought builds up dot by dot and an ear twitches
 * (stepped, on --dur-pulse; reduced motion shows the whole still mark).
 */
const PX = {
  b: 'M2 4h1v1h-1zM2 5h2v1h-2zM6 5h2v1h-2zM2 6h3v1h-3zM6 6h3v1h-3zM2 7h8v1h-8zM1 8h10v1h-10zM1 9h3v1h-3zM5 9h7v1h-7zM1 10h12v1h-12zM4 11h7v1h-7zM6 12h2v1h-2zM1 13h1v1h-1zM1 14h3v1h-3zM1 15h3v1h-3z',
  ear: 'M6 4h1v1h-1z',
  c: 'M1 11h3v1h-3zM1 12h5v1h-5zM2 13h4v1h-4z',
  e: 'M4 9h1v1h-1z',
  t1: 'M8 2h1v1h-1z',
  t2: 'M10 1h2v1h-2zM10 2h2v1h-2z',
  t3: 'M13 1h2v1h-2zM13 2h2v1h-2z',
}

type Size = 16 | 20 | 24 | 30 | 32 | 36 | 40 | 48

export const FoxMark = memo(function FoxMark({ size = 16, thinking = false, className = '' }: { size?: Size; thinking?: boolean; className?: string }) {
  const cell = Math.floor(size / 16)
  const pad = Math.floor((size - 16 * cell) / 2) / cell
  return (
    <svg
      className={'fox-mark' + (thinking ? ' thinking' : '') + (className ? ' ' + className : '')}
      width={size}
      height={size}
      viewBox={`${-pad} ${-pad} ${size / cell} ${size / cell}`}
      shapeRendering="crispEdges"
      aria-hidden
    >
      <path className="fox-body" d={PX.b} />
      <path className="fox-body fox-ear" d={PX.ear} />
      <path className="fox-cheek" d={PX.c} />
      <path className="fox-eye" d={PX.e} />
      <path className="fox-body fox-t1" d={PX.t1} />
      <path className="fox-body fox-t2" d={PX.t2} />
      <path className="fox-body fox-t3" d={PX.t3} />
    </svg>
  )
})
