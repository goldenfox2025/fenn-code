/** Shared native-input helpers for visible and background Electron checks. */
export async function resizeViewport(page, size) {
  await page.setViewportSize(size)
  await page.evaluate(() => {
    window.dispatchEvent(new Event('resize'))
    return new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve))).then(async () => {
      await Promise.allSettled(document.getAnimations().filter(animation => animation.effect?.getTiming().iterations !== Infinity).map(animation => animation.finished))
      await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))
    })
  })
}

/** A hidden window has no top-level hit-test surface for an out-of-process iframe.
 * Target that frame's native input session; events remain trusted pointer events. */
export async function pressInFrame(locator) {
  await locator.waitFor({ state: 'visible' })
  await locator.scrollIntoViewIfNeeded()
  const element = await locator.elementHandle()
  const frame = await element.ownerFrame()
  const page = frame.page()
  if (process.env.FENN_BACKGROUND_TEST !== '1') {
    const box = await locator.boundingBox()
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2)
    await page.mouse.down()
    return () => page.mouse.up()
  }
  const client = await page.context().newCDPSession(frame)
  const point = await locator.evaluate((el) => {
    const r = el.getBoundingClientRect()
    return { x: r.x + r.width / 2, y: r.y + r.height / 2 }
  })
  await client.send('Input.dispatchMouseEvent', { ...point, type: 'mouseMoved', button: 'none', buttons: 0 })
  await client.send('Input.dispatchMouseEvent', { ...point, type: 'mousePressed', button: 'left', buttons: 1, clickCount: 1 })
  return async () => {
    try { await client.send('Input.dispatchMouseEvent', { ...point, type: 'mouseReleased', button: 'left', buttons: 0, clickCount: 1 }) }
    finally { await client.detach() }
  }
}

export async function clickInFrame(locator) {
  if (process.env.FENN_BACKGROUND_TEST !== '1') return locator.click()
  const release = await pressInFrame(locator)
  await release()
}
