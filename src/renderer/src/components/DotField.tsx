import { useEffect, useRef } from 'react'

/** Grid pitch and dot size, in CSS pixels. */
const PITCH = 22
const DOT = 1
/** How far from the pointer the dots respond, and how much they lift toward it at most. */
const REACH = 150
const PULL = 2.5
/** How quickly the glow follows the pointer and fades once it leaves (per frame, 0–1). */
const FOLLOW = 0.18
/** Steps of glow strength; dots in one step are filled together. */
const BANDS = 12

/**
 * A faint grid of dots behind the content that lights up softly around the pointer.
 * One canvas: the resting grid is drawn once per size or look, and each frame redraws only
 * the patch around the pointer, in a few fills. Frames run only while the glow is moving, never when the
 * window is hidden or out of focus, and with reduced motion the grid stays still.
 */
export function DotField({ strength }: { strength: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const ctx = canvas?.getContext('2d')
    if (!canvas || !ctx) return
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    const grid = document.createElement('canvas')
    let w = 0, h = 0, dpr = 1
    let dot = '', accent = '', rest = 0
    // Where the glow is and where it is heading; level eases between 0 (gone) and 1.
    const at = { x: -1e4, y: -1e4, level: 0 }
    const to = { x: -1e4, y: -1e4, level: 0 }
    let frame = 0

    const readLook = () => {
      const css = getComputedStyle(canvas)
      dot = css.getPropertyValue('--dot-rgb').trim()
      accent = css.getPropertyValue('--accent-rgb').trim()
      rest = parseFloat(css.getPropertyValue('--dot-alpha')) || 0.08
    }
    const drawGrid = () => {
      const r = canvas.getBoundingClientRect()
      dpr = window.devicePixelRatio || 1
      w = r.width
      h = r.height
      for (const c of [canvas, grid]) {
        c.width = Math.round(w * dpr)
        c.height = Math.round(h * dpr)
      }
      dirty = null
      const g = grid.getContext('2d')!
      g.setTransform(dpr, 0, 0, dpr, 0, 0)
      g.beginPath()
      g.fillStyle = `rgba(${dot}, ${rest})`
      for (let y = PITCH / 2; y < h; y += PITCH)
        for (let x = PITCH / 2; x < w; x += PITCH) g.rect(x - DOT / 2, y - DOT / 2, DOT, DOT)
      g.fill()
      paint(true)
    }
    // The part of the canvas the glow last covered, in CSS pixels; only that and the new one are redrawn.
    let dirty: { x: number; y: number; w: number; h: number } | null = null
    const restore = (r: { x: number; y: number; w: number; h: number }) => {
      const x = Math.max(0, Math.floor(r.x * dpr)), y = Math.max(0, Math.floor(r.y * dpr))
      const rw = Math.min(canvas.width, Math.ceil((r.x + r.w) * dpr)) - x
      const rh = Math.min(canvas.height, Math.ceil((r.y + r.h) * dpr)) - y
      if (rw <= 0 || rh <= 0) return
      ctx.clearRect(x, y, rw, rh)
      ctx.drawImage(grid, x, y, rw, rh, x, y, rw, rh)
    }
    const paint = (full = false) => {
      ctx.setTransform(1, 0, 0, 1, 0, 0)
      if (full) restore({ x: 0, y: 0, w, h })
      else if (dirty) restore(dirty)
      dirty = null
      if (at.level < 0.01) return
      const pad = REACH + PITCH
      dirty = { x: at.x - pad, y: at.y - pad, w: pad * 2, h: pad * 2 }
      restore(dirty)
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      // Dots of about the same strength share one path and one fill, so a frame is a few draw calls.
      const paths: Path2D[] = []
      const x0 = Math.max(0, Math.floor((at.x - REACH) / PITCH)), x1 = Math.ceil((at.x + REACH) / PITCH)
      const y0 = Math.max(0, Math.floor((at.y - REACH) / PITCH)), y1 = Math.ceil((at.y + REACH) / PITCH)
      for (let j = y0; j <= y1; j++)
        for (let i = x0; i <= x1; i++) {
          const x = i * PITCH + PITCH / 2, y = j * PITCH + PITCH / 2
          if (x > w || y > h) continue
          const dx = at.x - x, dy = at.y - y
          const d = Math.hypot(dx, dy)
          if (d >= REACH) continue
          // Smooth falloff: full at the pointer, nothing at the edge of its reach.
          const f = (1 - d / REACH) ** 2 * at.level
          const band = Math.round(f * (BANDS - 1))
          if (!band) continue
          const lift = d ? (PULL * f) / d : 0
          const size = DOT + f * strength * 0.9
          ;(paths[band] ??= new Path2D()).rect(x + dx * lift - size / 2, y + dy * lift - size / 2, size, size)
        }
      paths.forEach((path, band) => {
        ctx.fillStyle = `rgba(${accent}, ${Math.min(0.9, (band / (BANDS - 1)) * strength * 0.55)})`
        ctx.fill(path)
      })
    }
    const tick = () => {
      frame = 0
      at.x += (to.x - at.x) * FOLLOW
      at.y += (to.y - at.y) * FOLLOW
      at.level += (to.level - at.level) * FOLLOW
      paint()
      const moving = Math.abs(to.x - at.x) + Math.abs(to.y - at.y) > 0.3 || Math.abs(to.level - at.level) > 0.005
      if (moving && !document.hidden) frame = requestAnimationFrame(tick)
    }
    const wake = () => {
      if (!frame && !still.matches) frame = requestAnimationFrame(tick)
    }
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      to.x = e.clientX - r.left
      to.y = e.clientY - r.top
      // Jump there when the glow was gone, rather than sweeping in from where it last was.
      if (at.level < 0.01) (at.x = to.x), (at.y = to.y)
      to.level = document.hasFocus() ? 1 : 0
      wake()
    }
    const away = () => {
      to.level = 0
      wake()
    }
    readLook()
    drawGrid()
    const ro = new ResizeObserver(drawGrid)
    ro.observe(canvas)
    // A change of look (颜色, 玻璃效果) changes the dots' colors.
    const mo = new MutationObserver(() => (readLook(), drawGrid()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', away)
    window.addEventListener('blur', away)
    document.addEventListener('visibilitychange', away)
    return () => {
      cancelAnimationFrame(frame)
      ro.disconnect()
      mo.disconnect()
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', away)
      window.removeEventListener('blur', away)
      document.removeEventListener('visibilitychange', away)
    }
  }, [strength])
  return <canvas ref={ref} className="dot-field" aria-hidden />
}
