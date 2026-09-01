import { formatLatexTranslation, RichTextNode } from './latex-format'

/** Build a document-shaped list containing formatted translations only. */
export function buildPanelLines(lineCount: number, translations: ReadonlyMap<number, string>): RichTextNode[][] {
  return Array.from({ length: lineCount }, (_, line) => {
    const translation = translations.get(line)
    return translation ? formatLatexTranslation(translation) : []
  })
}
