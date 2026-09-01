import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { MacOSHelperRunner, MacOSTranslator } from '../translator/macos'

describe('MacOSTranslator', () => {
  it('translates a batch and preserves result metadata', async () => {
    const runner: MacOSHelperRunner = async (helperPath, input) => {
      assert.equal(helperPath, '/test/helper')
      assert.deepEqual(input, { texts: ['Hello', 'World'], source: 'en', target: 'zh-CN' })
      return { translations: ['你好', '世界'], source: 'en', target: 'zh-Hans' }
    }
    const translator = new MacOSTranslator('/test/helper', runner, 'darwin')

    const results = await translator.translateMany(['Hello', 'World'], 'en', 'zh-CN')

    assert.deepEqual(results.map(result => result.text), ['你好', '世界'])
    assert.equal(results[0].provider, 'macos')
    assert.equal(results[0].target, 'zh-Hans')
  })

  it('translates a single string through the batch helper', async () => {
    const runner: MacOSHelperRunner = async () => ({
      translations: ['你好'], source: 'en', target: 'zh-Hans',
    })
    const translator = new MacOSTranslator('/test/helper', runner, 'darwin')

    const result = await translator.translate('Hello', 'en', 'zh-CN')

    assert.equal(result.text, '你好')
  })

  it('rejects a mismatched helper response', async () => {
    const runner: MacOSHelperRunner = async () => ({
      translations: [], source: 'en', target: 'zh-Hans',
    })
    const translator = new MacOSTranslator('/test/helper', runner, 'darwin')

    await assert.rejects(
      () => translator.translateMany(['Hello'], 'en', 'zh-CN'),
      /returned 0 results for 1 inputs/,
    )
  })

  it('rejects non-macOS platforms before launching the helper', async () => {
    let called = false
    const runner: MacOSHelperRunner = async () => {
      called = true
      return { translations: ['你好'], source: 'en', target: 'zh-Hans' }
    }
    const translator = new MacOSTranslator('/test/helper', runner, 'linux')

    await assert.rejects(() => translator.translate('Hello', 'en', 'zh-CN'), /only available on macOS 26/)
    assert.equal(called, false)
  })
})
