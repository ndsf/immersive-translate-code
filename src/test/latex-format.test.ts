import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  formatLatexTranslation,
  richTextToDisplayText,
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
    assert.deepStrictEqual(formatLatexTranslation('% preserved marker', false), [
      { style: 'comment', children: ['% preserved marker'] },
    ])
  })

  it('flattens and renders formatted text for editor surfaces', () => {
    const nodes = formatLatexTranslation('A \\textbf{bold} and \\textit{italic}.')
    assert.equal(richTextToPlainText(nodes), 'A bold and italic.')
    assert.equal(richTextToMarkdown(nodes), 'A **bold** and *italic*\\.')
  })

  it('renders headings, citations, and list items', () => {
    const nodes = formatLatexTranslation('\\section{Results} \\cite{smith2024} \\begin{itemize} \\item First')
    assert.deepStrictEqual(nodes, [
      { style: 'heading', level: 2, children: ['Results'] },
      ' ',
      { style: 'citation', children: ['smith2024'] },
      ' ',
      { style: 'listItem', children: ['First'] },
    ])
    assert.equal(richTextToDisplayText(nodes), 'Results [smith2024] • First')
    assert.equal(richTextToMarkdown(nodes), '**Results** [smith2024] - First')
  })

  it('hides known list environment wrappers', () => {
    assert.deepStrictEqual(formatLatexTranslation('\\end{itemize}'), [])
    assert.deepStrictEqual(formatLatexTranslation('\\begin{unknown}'), ['\\begin{unknown}'])
  })
})
