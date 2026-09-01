import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { shouldUseWrappedPreview } from '../display-mode'

describe('shouldUseWrappedPreview', () => {
  it('uses wrapped preview automatically whenever editor word wrap is enabled', () => {
    assert.equal(shouldUseWrappedPreview('auto', 'on'), true)
    assert.equal(shouldUseWrappedPreview('auto', 'bounded'), true)
    assert.equal(shouldUseWrappedPreview('auto', 'wordWrapColumn'), true)
    assert.equal(shouldUseWrappedPreview('auto', 'off'), false)
  })

  it('respects explicit display modes', () => {
    assert.equal(shouldUseWrappedPreview('wrapped-preview', 'off'), true)
    assert.equal(shouldUseWrappedPreview('inline', 'on'), false)
  })
})
