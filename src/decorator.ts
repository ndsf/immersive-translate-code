/**
 * Decoration manager — renders inline translations and loading indicators.
 * Encapsulates all VSCode decoration API interaction.
 */

import * as vscode from 'vscode'
import {
  formatLatexTranslation,
  richTextHasStyle,
  richTextToMarkdown,
  richTextToPlainText,
} from './latex-format'

export class DecorationManager {
  private translationType: vscode.TextEditorDecorationType
  private loadingType: vscode.TextEditorDecorationType

  constructor() {
    const style = {
      color: new vscode.ThemeColor('editorInlayHint.foreground'),
      fontStyle: 'italic',
      margin: '0 0 0 2em',
    }

    this.translationType = vscode.window.createTextEditorDecorationType({
      after: style,
    })

    this.loadingType = vscode.window.createTextEditorDecorationType({
      after: { ...style, contentText: '  …' },
    })
  }

  apply(editor: vscode.TextEditor, decorations: Map<number, string>, loading: Set<number>): void {
    const toDecos = (lines: Iterable<number>, opts?: (ln: number) => Partial<vscode.DecorationOptions>) =>
      [...lines]
        .filter(ln => ln < editor.document.lineCount)
        .map(ln => ({ range: editor.document.lineAt(ln).range, ...opts?.(ln) }))

    editor.setDecorations(this.translationType, toDecos(decorations.keys(), ln => {
      const translation = decorations.get(ln) ?? ''
      const richText = formatLatexTranslation(translation)
      const hover = new vscode.MarkdownString(richTextToMarkdown(richText))
      hover.isTrusted = false
      hover.supportHtml = false
      const after = {
        contentText: richTextToPlainText(richText),
        ...(richTextHasStyle(richText, 'bold') ? { fontWeight: 'bold' } : {}),
        ...(richTextHasStyle(richText, 'underline') ? { textDecoration: 'underline' } : {}),
        ...(richTextHasStyle(richText, 'code') ? { fontStyle: 'normal' } : {}),
        ...(richTextHasStyle(richText, 'comment') ? { color: new vscode.ThemeColor('editorCodeLens.foreground') } : {}),
      }
      return {
        hoverMessage: hover,
        renderOptions: { after },
      }
    }))
    editor.setDecorations(this.loadingType, toDecos(loading))
  }

  clear(editor: vscode.TextEditor): void {
    editor.setDecorations(this.translationType, [])
    editor.setDecorations(this.loadingType, [])
  }

  dispose(): void {
    this.translationType.dispose()
    this.loadingType.dispose()
  }
}
