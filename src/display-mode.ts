export type DisplayMode = 'auto' | 'inline' | 'wrapped-preview'

export function shouldUseWrappedPreview(mode: DisplayMode, wordWrap: string): boolean {
  if (mode === 'wrapped-preview') { return true }
  if (mode === 'inline') { return false }
  return wordWrap !== 'off'
}
