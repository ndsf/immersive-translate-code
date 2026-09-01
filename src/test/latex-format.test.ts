import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { formatLatexTranslation } from '../latex-format'

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
})
