import assert from 'node:assert/strict'
import { build } from 'esbuild'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'

const dir = await mkdtemp(join(tmpdir(), 'anycord-viewport-'))
try {
  await build({ entryPoints: ['app/utils/mobile-viewport.ts'], outfile: join(dir, 'viewport.mjs'), bundle: true, format: 'esm', platform: 'node' })
  const { installMobileViewport } = await import(pathToFileURL(join(dir, 'viewport.mjs')))
  function root() {
    const names = new Set()
    return { classList: { toggle(name, value) { value ? names.add(name) : names.delete(name) }, remove(name) { names.delete(name) }, contains(name) { return names.has(name) } } }
  }
  function environment(hasViewport = true) {
    const win = new EventTarget(), doc = new EventTarget(), media = new EventTarget(), viewport = new EventTarget()
    Object.assign(viewport, { height: 750, offsetTop: 0, scale: 1 })
    Object.assign(media, { matches: true })
    const frames = new Map()
    let id = 0, current
    Object.assign(win, {
      innerWidth: 393, innerHeight: 750, scrollX: 0, scrollY: 0,
      visualViewport: hasViewport ? viewport : undefined,
      matchMedia: () => media,
      requestAnimationFrame(callback) { frames.set(++id, callback); return id },
      cancelAnimationFrame(key) { frames.delete(key) },
      scrollTo({ left, top }) { win.scrollX = left; win.scrollY = top; win.dispatchEvent(new Event('scroll')) },
    })
    Object.assign(doc, { documentElement: root(), body: root(), activeElement: null })
    const stop = installMobileViewport(win, doc, value => { current = value })
    function flush() {
      for (let n = 0; frames.size && n < 5; n++) {
        const batch = [...frames.values()]; frames.clear(); batch.forEach(fn => fn())
      }
      assert.equal(frames.size, 0, 'viewport updates must settle instead of a scroll/resize feedback loop')
    }
    function focus() {
      doc.activeElement = { closest: () => ({}), matches: () => true }
      doc.dispatchEvent(new Event('focusin')); flush()
    }
    return { win, doc, media, viewport, stop, flush, focus, state: () => current }
  }
  const e = environment()
  assert.deepEqual(e.state(), { height: 750, top: 0, keyboard: false })
  assert.equal(e.doc.body.classList.contains('mobile-chat-viewport'), true)
  e.focus()
  // WebKit focuses the caret, shrinks the visual viewport and independently
  // pans the root document. Only the message history should ever scroll.
  for (const [height, pan, offsetTop] of [[620, 84, 0], [410, 210, 96], [390, 240, 110]]) {
    Object.assign(e.viewport, { height, offsetTop }); e.win.scrollY = pan
    e.viewport.dispatchEvent(new Event('resize')); e.win.dispatchEvent(new Event('scroll')); e.flush()
    assert.equal(e.win.scrollY, 0, 'keyboard focus must not pan the entire chat document')
    assert.deepEqual(e.state(), { height, top: offsetTop, keyboard: true })
  }
  // Pinch zoom must stay under the user's control.
  e.viewport.scale = 1.5; e.win.scrollY = 40
  const beforeZoom = e.state()
  e.viewport.dispatchEvent(new Event('scroll')); e.flush()
  assert.equal(e.win.scrollY, 40); assert.equal(e.state(), beforeZoom)
  e.viewport.scale = 1
  // Some WebKit versions retain a stale offset after dismissing the keyboard.
  e.doc.activeElement = null; e.viewport.height = 750
  e.doc.dispatchEvent(new Event('focusout')); e.viewport.dispatchEvent(new Event('resize')); e.flush()
  assert.deepEqual(e.state(), { height: 750, top: 0, keyboard: false })
  assert.equal(e.win.scrollY, 0)
  // Desktop and leaving the workspace release document locking.
  e.media.matches = false; e.media.dispatchEvent(new Event('change')); e.flush()
  assert.deepEqual(e.state(), { top: 0, keyboard: false })
  assert.equal(e.doc.body.classList.contains('mobile-chat-viewport'), false)
  e.media.matches = true; e.media.dispatchEvent(new Event('change')); e.flush()
  e.viewport.dispatchEvent(new Event('resize')); e.stop(); e.flush()
  assert.equal(e.doc.documentElement.classList.contains('mobile-chat-viewport'), false)
  e.win.scrollY = 17; e.win.dispatchEvent(new Event('scroll')); e.flush()
  assert.equal(e.win.scrollY, 17, 'cleanup must release scrolling on landing/login pages')
  const fallback = environment(false)
  fallback.focus(); fallback.win.innerHeight = 420; fallback.win.scrollY = 100
  fallback.win.dispatchEvent(new Event('resize')); fallback.flush()
  assert.deepEqual(fallback.state(), { height: 420, top: 0, keyboard: true })
  assert.equal(fallback.win.scrollY, 0); fallback.stop()
  console.log('PASS: keyboard pan recovery, animated viewport resize, zoom preservation, stale offset recovery and route cleanup.')
} finally { await rm(dir, { recursive: true, force: true }) }
