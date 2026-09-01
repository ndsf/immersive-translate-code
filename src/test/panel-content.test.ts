import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { buildPanelLines } from '../panel-content'

describe('buildPanelLines', () => {
  it('keeps document line positions while including translations only', () => {
    const translations = new Map([
      [0, '第一行'],
      [2, '第三行'],
    ])

    assert.deepStrictEqual(buildPanelLines(4, translations), ['第一行', '', '第三行', ''])
  })

  it('drops translations outside the current document', () => {
    const translations = new Map([[3, '旧行']])
    assert.deepStrictEqual(buildPanelLines(2, translations), ['', ''])
  })
})
