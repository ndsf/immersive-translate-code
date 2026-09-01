/** Build a document-shaped list containing translations only. */
export function buildPanelLines(lineCount: number, translations: ReadonlyMap<number, string>): string[] {
  return Array.from({ length: lineCount }, (_, line) => translations.get(line) ?? '')
}
