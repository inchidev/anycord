export interface ChatViewport {
  height?: number
  top: number
  keyboard: boolean
}

// The document is not a scroll container in the workspace. WebKit can still pan
// it to reveal a focused textarea, independently of visualViewport's offset.
export function installMobileViewport(win: Window, doc: Document, update: (viewport: ChatViewport) => void) {
  const media = win.matchMedia('(max-width: 700px)')
  const viewport = win.visualViewport
  const roots = [doc.documentElement, doc.body]
  let frame = 0
  let layoutHeight = win.innerHeight
  let layoutWidth = win.innerWidth
  let disposed = false

  function measure() {
    frame = 0
    if (disposed) return
    for (const root of roots) root.classList.toggle('mobile-chat-viewport', media.matches)
    if (!media.matches) { update({ top: 0, keyboard: false }); return }
    // Pinch zoom is user navigation, not a keyboard resize. Do not undo it.
    if (viewport && Math.abs(viewport.scale - 1) > 0.01) return
    const focused = !!doc.activeElement?.closest('.workspace-client') && doc.activeElement.matches('input, textarea, [contenteditable="true"]')
    if (!focused || layoutWidth !== win.innerWidth) {
      layoutHeight = win.innerHeight
      layoutWidth = win.innerWidth
    }
    const height = viewport?.height || win.innerHeight
    const keyboard = focused && layoutHeight - height > 120
    if (win.scrollX || win.scrollY) win.scrollTo({ left: 0, top: 0, behavior: 'instant' })
    update({ height, top: keyboard ? Math.max(0, viewport?.offsetTop || 0) : 0, keyboard })
  }
  function schedule() {
    if (!frame && !disposed) frame = win.requestAnimationFrame(measure)
  }
  const sources: Array<[EventTarget, string]> = [
    [win, 'resize'], [win, 'scroll'], [media, 'change'],
    [doc, 'focusin'], [doc, 'focusout'],
    ...(viewport ? [[viewport, 'resize'], [viewport, 'scroll']] as Array<[EventTarget, string]> : []),
  ]
  for (const [target, event] of sources) target.addEventListener(event, schedule)
  measure()
  return () => {
    disposed = true
    if (frame) win.cancelAnimationFrame(frame)
    for (const [target, event] of sources) target.removeEventListener(event, schedule)
    for (const root of roots) root.classList.remove('mobile-chat-viewport')
  }
}
