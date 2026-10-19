import { useEffect, useRef } from 'react'

/** Grid pitch and dot size, in CSS pixels. */
const PITCH = 22
const DOT = 1
/** How far from the pointer the dots respond, and how much they lift toward it at most. */
const REACH = 140
const PULL = 2.5
/** How long the glow takes to catch up with the pointer, and how long a lit dot takes to fade (seconds, 1/e). */
const LAG = 0.09
const FADE = [0, 0.32, 0.38]
/** Steps of glow strength; dots in one step are filled together. */
const BANDS = 16
/** How much the fading end of the trail is lifted (below 1 lifts it). */
const GAMMA = 0.6
/** How much brighter the trail is drawn than the head, per strength (times the look's --dot-trail); and how quickly a dot turns from one to the other (seconds). */
const BOOST = [0, 1.6, 0.6]
const TRAIL_EASE = 0.12
const MAX_ALPHA = 0.9
/** The glow canvas grows in steps of this many CSS pixels. */
const GROW = 6 * PITCH

/**
 * How opaque a dot lit to `v` (0–1) is drawn. The head (v = 1) is as strong as ever; the lower end
 * is lifted, so the trail stays visible as it fades, and eases to nothing at the very end.
 */
function glowAlpha(v: number, strength: number): number {
  return Math.min(MAX_ALPHA, strength * 0.55 * Math.max(0, (v ** GAMMA - 0.1) / 0.9))
}

/**
 * A faint grid of dots behind the content that lights up softly around the pointer and
 * leaves a short fading trail where it passed. The resting grid is one canvas drawn once
 * per size or look; the glow is a second canvas that covers only the lit dots and is
 * repainted each frame in a few fills. Frames run only while something is lit or moving,
 * never while the window is hidden, and with reduced motion the grid stays still.
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
    // Nothing is lit yet: no backing store (a canvas starts at 300×150).
    glow.width = glow.height = 0
    const still = matchMedia('(prefers-reduced-motion: reduce)')
    const fade = FADE[strength] ?? FADE[1]
    let w = 0, h = 0, dpr = 1, cols = 0, rows = 0
    let dot = '', accent = '', rest = 0
    // Where the glow's head is and where it is heading; level eases between 0 (gone) and 1.
    const at = { x: -1e4, y: -1e4, level: 0 }
    const to = { x: -1e4, y: -1e4, level: 0 }
    // How lit each dot is (0–1), and the dots that are lit at all.
    let heat = new Float32Array(0)
    // How much each lit dot counts as trail rather than head (0–1, eased), and the frame the head last
    // held it: the trail is drawn brighter than the head, so it shows as it fades.
    let trail = new Float32Array(0)
    let heldAt = new Uint32Array(0)
    let stamp = 0
    let boost = 0
    let lit: number[] = []
    let frame = 0, last = 0

    const readLook = () => {
      const css = getComputedStyle(canvas)
      dot = css.getPropertyValue('--dot-rgb').trim()
      accent = css.getPropertyValue('--accent-rgb').trim()
      rest = parseFloat(css.getPropertyValue('--dot-alpha')) || 0.08
      boost = (BOOST[strength] ?? BOOST[1]) * (parseFloat(css.getPropertyValue('--dot-trail')) || 1)
    }
    // The resting grid: drawn once per size or look, never per frame.
    const drawGrid = () => {
      const r = canvas.getBoundingClientRect()
      dpr = window.devicePixelRatio || 1
      w = r.width
      h = r.height
      canvas.width = Math.round(w * dpr)
      canvas.height = Math.round(h * dpr)
      cols = Math.ceil(w / PITCH)
      rows = Math.ceil(h / PITCH)
      heat = new Float32Array(cols * rows)
      trail = new Float32Array(cols * rows)
      heldAt = new Uint32Array(cols * rows)
      lit = []
      paint()
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
      ctx.beginPath()
      ctx.fillStyle = `rgba(${dot}, ${rest})`
      for (let y = PITCH / 2; y < h; y += PITCH)
        for (let x = PITCH / 2; x < w; x += PITCH) ctx.rect(x - DOT / 2, y - DOT / 2, DOT, DOT)
      ctx.fill()
      // A pointer resting over the area lights it again at once.
      if (at.level > 0.01) wake()
    }
    // The head lights the dots within its reach; a dot keeps the brightest it has been and then fades.
    // Returns how many lit dots the head holds where they are (they stop changing once the head rests).
    const warm = () => {
      let held = 0
      if (at.level < 0.01) return held
      const i0 = Math.max(0, Math.floor((at.x - REACH) / PITCH)), i1 = Math.min(cols - 1, Math.ceil((at.x + REACH) / PITCH))
      const j0 = Math.max(0, Math.floor((at.y - REACH) / PITCH)), j1 = Math.min(rows - 1, Math.ceil((at.y + REACH) / PITCH))
      for (let j = j0; j <= j1; j++)
        for (let i = i0; i <= i1; i++) {
          const d = Math.hypot(at.x - (i * PITCH + PITCH / 2), at.y - (j * PITCH + PITCH / 2))
          if (d >= REACH) continue
          // Smooth falloff: full at the pointer, nothing at the edge of its reach. Steeper than it
          // shows, since glowAlpha lifts low values: around the head it reads as (1 - d / REACH)².
          const f = (1 - d / REACH) ** (2 / GAMMA) * at.level
          const k = j * cols + i
          if (f >= heat[k] && f >= 0.02) {
            if (!heat[k]) lit.push(k)
            heat[k] = f
            heldAt[k] = stamp
            held++
          }
        }
      return held
    }
    // The glow canvas covers just the lit dots: it moves to them each frame and grows in steps when
    // the trail outgrows it, so a frame uploads a small patch however large the window is.
    let gw = 0, gh = 0
    const fit = (need: number, have: number) => (need <= have ? have : Math.ceil(need / GROW) * GROW)
    const paint = () => {
      if (!lit.length) {
        if (gw) {
          gw = gh = glow.width = glow.height = 0
          glow.style.width = glow.style.height = '0'
        }
        return
      }
      let i0 = cols, j0 = rows, i1 = 0, j1 = 0
      for (const k of lit) {
        const i = k % cols, j = (k - i) / cols
        if (i < i0) i0 = i
        if (i > i1) i1 = i
        if (j < j0) j0 = j
        if (j > j1) j1 = j
      }
      // A cell of margin each side holds a dot's lean and size.
      const ox = (i0 - 1) * PITCH, oy = (j0 - 1) * PITCH
      const bw = fit((i1 - i0 + 3) * PITCH, gw), bh = fit((j1 - j0 + 3) * PITCH, gh)
      if (bw !== gw || bh !== gh) {
        gw = bw
        gh = bh
        glow.width = Math.round(gw * dpr)
        glow.height = Math.round(gh * dpr)
        glow.style.width = `${gw}px`
        glow.style.height = `${gh}px`
      } else {
        gtx.setTransform(1, 0, 0, 1, 0, 0)
        gtx.clearRect(0, 0, glow.width, glow.height)
      }
      glow.style.transform = `translate3d(${ox}px, ${oy}px, 0)`
      gtx.setTransform(dpr, 0, 0, dpr, -ox * dpr, -oy * dpr)
      // Dots of about the same strength share one path and one fill, so a frame is a few draw calls.
      const paths: Path2D[] = []
      for (const k of lit) {
        const v = heat[k]
        const band = Math.min(BANDS - 1, Math.round((glowAlpha(v, strength) * (1 + boost * trail[k]) / MAX_ALPHA) * (BANDS - 1)))
        if (!band) continue
        const x = (k % cols) * PITCH + PITCH / 2, y = Math.floor(k / cols) * PITCH + PITCH / 2
        // Lit dots near the head lean toward it a little.
        const dx = at.x - x, dy = at.y - y
        const d = Math.hypot(dx, dy)
        const lift = d && d < REACH ? (PULL * v * (1 - d / REACH)) / d : 0
        const size = DOT + v * strength * 0.9 * (1 + boost * trail[k] * 0.5)
        ;(paths[band] ??= new Path2D()).rect(x + dx * lift - size / 2, y + dy * lift - size / 2, size, size)
      }
      paths.forEach((path, band) => {
        gtx.fillStyle = `rgba(${accent}, ${(band / (BANDS - 1)) * MAX_ALPHA})`
        gtx.fill(path)
      })
    }
    const tick = (now: number) => {
      frame = 0
      // Time-based, so the trail is as long at 120 Hz as at 60 Hz; a long gap counts as one frame.
      const dt = Math.min(0.05, last ? (now - last) / 1000 : 1 / 60)
      last = now
      const follow = 1 - Math.exp(-dt / LAG)
      at.x += (to.x - at.x) * follow
      at.y += (to.y - at.y) * follow
      at.level += (to.level - at.level) * follow
      const cool = Math.exp(-dt / fade)
      for (const k of lit) heat[k] *= cool
      stamp++
      const held = warm()
      lit = lit.filter((k) => heat[k] >= 0.02 || ((heat[k] = trail[k] = 0), false))
      // A dot the head has left turns to trail; one it comes back to turns to head again.
      const shift = dt / TRAIL_EASE
      let easing = false
      for (const k of lit) {
        if (heldAt[k] === stamp) {
          trail[k] = Math.max(0, trail[k] - shift)
          if (trail[k]) easing = true
        } else trail[k] = Math.min(1, trail[k] + shift)
      }
      paint()
      const moving = Math.abs(to.x - at.x) + Math.abs(to.y - at.y) > 0.3 || Math.abs(to.level - at.level) > 0.005
      // Once the head rests, only the trail behind it still changes; with that gone the frames stop.
      if ((moving || easing || lit.length > held) && !document.hidden) frame = requestAnimationFrame(tick)
      else last = 0
    }
    const wake = () => {
      // With reduced motion the glow is off: one that was lit goes out at once.
      if (still.matches) {
        cancelAnimationFrame(frame)
        frame = last = 0
        at.level = to.level = 0
        heat.fill(0)
        trail.fill(0)
        lit = []
        return paint()
      }
      if (!frame) frame = requestAnimationFrame(tick)
    }
    const onMove = (e: PointerEvent) => {
      const r = canvas.getBoundingClientRect()
      to.x = e.clientX - r.left
      to.y = e.clientY - r.top
      // Start there when the glow was gone, rather than sweeping in from where it last was.
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
    // A drag that resizes the area redraws the grid at most once a frame.
    let sized = 0
    const ro = new ResizeObserver(() => (sized ||= requestAnimationFrame(() => ((sized = 0), drawGrid()))))
    ro.observe(canvas)
    // A change of look (颜色, 玻璃效果) changes the dots' colors.
    const mo = new MutationObserver(() => (readLook(), drawGrid()))
    mo.observe(document.documentElement, { attributes: true, attributeFilter: ['data-theme'] })
    // Moving to a screen of another density keeps the CSS size, so the resize observer never hears of it.
    let density: MediaQueryList | undefined
    const onDensity = () => (drawGrid(), watchDensity())
    const watchDensity = () => {
      density?.removeEventListener('change', onDensity)
      density = matchMedia(`(resolution: ${window.devicePixelRatio || 1}dppx)`)
      density.addEventListener('change', onDensity)
    }
    watchDensity()
    still.addEventListener('change', wake)
    window.addEventListener('pointermove', onMove, { passive: true })
    document.documentElement.addEventListener('pointerleave', away)
    window.addEventListener('blur', away)
    document.addEventListener('visibilitychange', away)
    return () => {
      cancelAnimationFrame(frame)
      cancelAnimationFrame(sized)
      ro.disconnect()
      mo.disconnect()
      density?.removeEventListener('change', onDensity)
      still.removeEventListener('change', wake)
      window.removeEventListener('pointermove', onMove)
      document.documentElement.removeEventListener('pointerleave', away)
      window.removeEventListener('blur', away)
      document.removeEventListener('visibilitychange', away)
    }
  }, [strength])
  return (
    <div className="dot-layer" aria-hidden>
      <canvas ref={ref} className="dot-field" />
      <canvas ref={glowRef} className="dot-glow" />
    </div>
  )
}
