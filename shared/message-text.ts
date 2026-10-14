// Plain Vue text nodes render these blocks; no message HTML is executed.
export function messageBlocks(text: string) {
  const blocks: { quote: boolean; text: string }[] = []
  for (const line of text.split('\n')) {
    const quote = line.startsWith('> ' ) || line === '>'
    const content = quote ? line.replace(/^> ?/, '') : line
    const last = blocks.at(-1)
    if (last && last.quote === quote) last.text += `\n${content}`
    else blocks.push({ quote, text: content })
  }
  return blocks
}
export function quoteMessage(author: string, text: string) {
  return `${author}:\n${text}`.split('\n').map((line) => `> ${line}`).join('\n') + '\n\n'
}
