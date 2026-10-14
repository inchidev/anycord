// Provider pictures are rendered by the browser, never fetched with bot tokens.
export function profileImage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 2048) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' && !url.username && !url.password ? url.href : null
  } catch { return null }
}

export function profileInitials(name: string) {
  const words = name.trim().split(/\s+/).filter(Boolean)
  const glyphs = (value: string) => [...new Intl.Segmenter(undefined, { granularity: 'grapheme' }).segment(value)].map(part => part.segment)
  return (words.length > 1 ? (glyphs(words[0]!)[0] || '') + (glyphs(words.at(-1)!)[0] || '') : glyphs(name.trim()).slice(0, 2).join('')).toUpperCase() || '?'
}
