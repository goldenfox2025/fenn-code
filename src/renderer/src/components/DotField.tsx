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
 * The resting grid is one canvas drawn once per size or look; the glow is a small second
 * canvas that follows the pointer, so a frame repaints only that patch, in a few fills. Frames run only while the glow is moving, never when the
 * window is hidden or out of focus, and with reduced motion the grid stays still.
 */
export function DotField({ strength }: { strength: number }) {
  const ref = useRef<HTMLCanvasElement>(null)
  const glowRef = useRef<HTMLCanvasElement>(null)
  useEffect(() => {
    const canvas = ref.current
    const glow = glowRef.current
    const ctx = canvas?.getContext('2d')
    const gtx = glow?.getContext('2d')
    if (!canvas || !glow || !ctx || !gtx) return
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    let w = 0, h = 0, dpr = 1
    let dot = '', accent = '', rest = 0
    // Where the glow is and where it is heading; level eases between 0 (gone) and 1.
    const at = { x: -1e4, y: -1e4, level: 0 }
    const to = { x: -1e4, y: -1e4, level: 0 }
    let frame = 0
    // The glow canvas spans the pointer's reach plus a cell each side, and moves a whole cell at a time.
    const cells = Math.ceil((REACH * 2) / PITCH) + 2
    const span = cells * PITCH

    const readLook = () => {
      const css = getComputedStyle(canvas)
      dot = css.getPropertyValue('--dot-rgb').trim()
      accent = css.getPropertyValue('--accent-rgb').trim()
      rest = parseFloat(css.getPropertyValue('--dot-alpha')) || 0.08
    }
    // The resting grid: drawn once per size or look, never per frame.
    const drawGrid = () => {
      const r = canvas.getBoundingClientRect()
      dpr = window.devicePixelRatio || 1
      w = r.width
      h = r.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      glow.width = glow.height = Math.round(span * dpr)
      glow.style.width = glow.style.height = `${span}px`
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.beginPath()
      ctx.fillStyle = `rgba(${dot}, ${rest})`
      for (let y = PITCH / 2; y < h; y += PITCH)
        for (let x = PITCH / 2; x < w; x += PITCH) ctx.rect(x - DOT / 2, y - DOT / 2, DOT, DOT)
      ctx.fill()
      paint()
    }
    let shown = false
    const paint = () => {
      gtx.setTransform(1, 0, 0, 1, 0, 0)
      gtx.clearRect(0, 0, glow.width, glow.height)
      if (at.level < 0.01) {
        if (shown) (glow.style.visibility = 'hidden'), (shown = false)
        return
      }
      const ci = Math.floor((at.x - REACH) / PITCH) - 1, cj = Math.floor((at.y - REACH) / PITCH) - 1
      const ox = ci * PITCH, oy = cj * PITCH
      glow.style.transform = `translate3d(${ox}px, ${oy}px, 0)`
      if (!shown) (glow.style.visibility = ''), (shown = true)
      gtx.setTransform(dpr, 0, 0, dpr, -ox * dpr, -oy * dpr)
      // Dots of about the same strength share one path and one fill, so a frame is a few draw calls.
      const paths: Path2D[] = []
      for (let j = Math.max(0, cj); j < cj + cells; j++)
        for (let i = Math.max(0, ci); i < ci + cells; i++) {
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
        gtx.fillStyle = `rgba(${accent}, ${Math.min(0.9, (band / (BANDS - 1)) * strength * 0.55)})`
        gtx.fill(path)
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
  return (
    <div className="dot-layer" aria-hidden>
      <canvas ref={ref} className="dot-field" />
      <canvas ref={glowRef} className="dot-glow" style={{ visibility: 'hidden' }} />
    </div>
  )
}
