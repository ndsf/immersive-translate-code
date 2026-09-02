import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatLatexTranslation,
  richTextToMarkdown,
  richTextToPlainText,
} from '../latex-format'

describe('formatLatexTranslation', () => {
  it('formats and unwraps supported text commands', () => {
    assert.deepStrictEqual(
      formatLatexTranslation('A \\textit{local \\textbf{resize}} with \\text{plain text}.'),
      [
        'A ',
        { style: 'italic', children: ['local ', { style: 'bold', children: ['resize'] }] },
        ' with plain text.',
      ],
    )
  })

  it('accepts capitalization introduced by a translation provider', () => {
    assert.deepEqual(formatLatexTranslation('A \\Textit{translated phrase}.'), [
      'A ',
      { style: 'italic', children: ['translated phrase'] },
      '.',
    ])
  })

  it('decodes escaped LaTeX punctuation', () => {
    assert.deepStrictEqual(formatLatexTranslation('50\\% A\\_B \\& C'), ['50% A_B & C'])
  })

  it('preserves unknown commands as text', () => {
    assert.deepStrictEqual(formatLatexTranslation('x \\unknown{y}'), ['x \\unknown{y}'])
  })

  it('marks percent-prefixed lines as comments while keeping nested styles', () => {
    assert.deepStrictEqual(formatLatexTranslation('  % \\textbf{generated comment}'), [
      {
        style: 'comment',
        children: ['  % ', { style: 'bold', children: ['generated comment'] }],
      },
    ])
  })

  it('flattens and renders formatted text for editor surfaces', () => {
    const nodes = formatLatexTranslation('A \\textbf{bold} and \\textit{italic}.')
    assert.equal(richTextToPlainText(nodes), 'A bold and italic.')
    assert.equal(richTextToMarkdown(nodes), 'A **bold** and *italic*\\.')
  })
})
