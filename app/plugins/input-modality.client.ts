export default defineNuxtPlugin(() => {
  const root = document.documentElement
  // Dialog/menu focus restoration can match :focus-visible after a tap on iOS.
  // Keep keyboard focus rings, including when a hardware keyboard is attached.
  document.addEventListener('pointerdown', () => { root.dataset.inputModality = 'pointer' }, { capture: true, passive: true })
  document.addEventListener('keydown', event => {
    if (!event.metaKey && !event.ctrlKey && !event.altKey) root.dataset.inputModality = 'keyboard'
  }, { capture: true })
})
