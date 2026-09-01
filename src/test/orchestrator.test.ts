import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { groupConsecutive, TranslationOrchestrator, OrchestratorDeps } from '../orchestrator'
import { TranslationCache } from '../cache'

describe('groupConsecutive', () => {
  it('groups consecutive numbers', () => {
    assert.deepStrictEqual(groupConsecutive([1, 2, 3, 5, 6, 8]), [[1, 2, 3], [5, 6], [8]])
  })

  it('splits groups exceeding max size', () => {
    assert.deepStrictEqual(groupConsecutive([1, 2, 3, 4, 5, 6], 3), [[1, 2, 3], [4, 5, 6]])
  })

  it('returns empty for empty input', () => {
    assert.deepStrictEqual(groupConsecutive([]), [])
  })

  it('handles single element', () => {
    assert.deepStrictEqual(groupConsecutive([5]), [[5]])
  })
})

describe('TranslationOrchestrator', () => {
  function createMockDeps(lines: string[], overrides?: Partial<OrchestratorDeps>): OrchestratorDeps {
    return {
      getLineText: (ln) => lines[ln] ?? '',
      getLineCount: () => lines.length,
      translateBatch: async (texts) => texts.map(t => `[translated] ${t}`),
      onUpdate: () => {},
      cache: new TranslationCache(),
      provider: 'google-translate',
      sourceLanguage: 'en',
      targetLanguage: 'zh-CN',
      ...overrides,
    }
  }

  it('translates visible lines', async () => {
    const lines = ['Hello world', 'This is a test', '---', 'Another line']
    const updates: Array<{ decorations: Map<number, string>; loading: Set<number> }> = []

    const deps = createMockDeps(lines, {
      onUpdate: (decorations, loading) => {
        updates.push({ decorations: new Map(decorations), loading: new Set(loading) })
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 4)

    const lastUpdate = updates[updates.length - 1]
    assert.equal(lastUpdate.decorations.has(0), true)
    assert.equal(lastUpdate.decorations.has(1), true)
    assert.equal(lastUpdate.decorations.has(2), false)
    assert.equal(lastUpdate.decorations.has(3), true)
    assert.equal(lastUpdate.loading.size, 0)
  })

  it('uses cache for already translated text', async () => {
    const lines = ['Hello world']
    let batchCount = 0

    const deps = createMockDeps(lines, {
      translateBatch: async (texts) => {
        batchCount++
        return texts.map(t => `[translated] ${t}`)
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 1)
    assert.equal(batchCount, 1)

    // Reset state but keep cache
    orch.reset()
    await orch.translateRange(0, 1)
    assert.equal(batchCount, 1)
  })

  it('skips code block lines', async () => {
    const lines = ['Hello', '```', 'code here', '```', 'World']
    const batches: string[][] = []

    const deps = createMockDeps(lines, {
      translateBatch: async (texts) => {
        batches.push([...texts])
        return texts.map(t => `[t] ${t}`)
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 5)

    const allTranslated = batches.flat()
    assert.deepStrictEqual(allTranslated, ['Hello', 'World'])
  })

  it('handles translate errors gracefully', async () => {
    const lines = ['Hello', 'World']

    const deps = createMockDeps(lines, {
      translateBatch: async () => { throw new Error('API error') },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 2)
  })

  it('sends batch with multiple lines in one call', async () => {
    const lines = ['Hello', 'World', 'Test']
    let callCount = 0

    const deps = createMockDeps(lines, {
      translateBatch: async (texts) => {
        callCount++
        return texts.map(t => `[t] ${t}`)
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 3)

    // All 3 consecutive lines should be in one batch (< BATCH_SIZE of 5)
    assert.equal(callCount, 1)
  })

  it('only sends uncached lines to translateBatch', async () => {
    const lines = ['Hello', 'World', 'Test']
    const cache = new TranslationCache()
    // Pre-populate cache for line 1 ("World")
    cache.set(cache.buildKey('World', 'google-translate', 'en', 'zh-CN'), '世界')

    const batchedTexts: string[][] = []
    const deps = createMockDeps(lines, {
      cache,
      translateBatch: async (texts) => {
        batchedTexts.push([...texts])
        return texts.map(t => `[t] ${t}`)
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 3)

    // Only "Hello" and "Test" should be sent; "World" is cached
    assert.deepStrictEqual(batchedTexts.flat(), ['Hello', 'Test'])
  })

  it('preserves decorations across batches', async () => {
    const lines = ['Line A', 'Line B', '---', 'Line C', 'Line D']
    const updates: Array<{ decorations: Map<number, string> }> = []

    const deps = createMockDeps(lines, {
      onUpdate: (decorations) => {
        updates.push({ decorations: new Map(decorations) })
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 5)

    // Final update should have all translatable lines (0, 1, 3, 4)
    const last = updates[updates.length - 1]
    assert.equal(last.decorations.has(0), true)
    assert.equal(last.decorations.has(1), true)
    assert.equal(last.decorations.has(3), true)
    assert.equal(last.decorations.has(4), true)
    assert.equal(last.decorations.size, 4)
  })

  it('isComplete reflects whether every line has been processed', async () => {
    const lines = ['Hello', 'World', '---', 'Test']
    const orch = new TranslationOrchestrator(createMockDeps(lines))

    assert.equal(orch.isComplete(), false)

    // Partial range — not yet complete
    await orch.translateRange(0, 2)
    assert.equal(orch.isComplete(), false)

    // Full file covered (including skipped '---' line, which still enters `done`)
    await orch.translateRange(2, 4)
    assert.equal(orch.isComplete(), true)

    // Reset clears done set
    orch.reset()
    assert.equal(orch.isComplete(), false)
  })

  it('reapply triggers onUpdate with current decorations', async () => {
    const lines = ['Hello world', 'Another line']
    const updates: Array<{ decorations: Map<number, string>; loading: Set<number> }> = []

    const deps = createMockDeps(lines, {
      onUpdate: (decorations, loading) => {
        updates.push({ decorations: new Map(decorations), loading: new Set(loading) })
      },
    })

    const orch = new TranslationOrchestrator(deps)
    await orch.translateRange(0, 2)

    const beforeCount = updates.length
    orch.reapply()

    assert.equal(updates.length, beforeCount + 1)
    const last = updates[updates.length - 1]
    assert.equal(last.decorations.size, 2)
    assert.equal(last.loading.size, 0)
  })

  it('retranslates changed text after reset', async () => {
    const lines = ['Hello']
    const batches: string[][] = []
    const updates: Array<Map<number, string>> = []
    const deps = createMockDeps(lines, {
      translateBatch: async (texts) => {
        batches.push([...texts])
        return texts.map(text => `[translated] ${text}`)
      },
      onUpdate: decorations => updates.push(new Map(decorations)),
    })
    const orch = new TranslationOrchestrator(deps)

    await orch.translateRange(0, 1)
    lines[0] = 'Updated'
    orch.reset()
    await orch.translateRange(0, 1)

    assert.deepStrictEqual(batches, [['Hello'], ['Updated']])
    assert.equal(updates.at(-1)?.get(0), '[translated] Updated')
  })

  it('keeps unaffected translations visible while refreshing an edited line', async () => {
    const lines = ['First', 'Middle', 'Last']
    const batches: string[][] = []
    const updates: Array<Map<number, string>> = []
    const deps = createMockDeps(lines, {
      translateBatch: async (texts) => {
        batches.push([...texts])
        return texts.map(text => `[translated] ${text}`)
      },
      onUpdate: decorations => updates.push(new Map(decorations)),
    })
    const orch = new TranslationOrchestrator(deps)

    await orch.translateRange(0, 3)
    lines[2] = 'Changed'
    orch.applyDocumentChanges([{ startLine: 2, endLine: 2, insertedLineBreaks: 0 }])

    const whileEditing = updates.at(-1)
    assert.equal(whileEditing?.get(0), '[translated] First')
    assert.equal(whileEditing?.get(1), '[translated] Middle')
    assert.equal(whileEditing?.has(2), false)

    await orch.translateRange(0, 3)
    assert.deepStrictEqual(batches, [['First', 'Middle', 'Last'], ['Changed']])
    assert.equal(updates.at(-1)?.get(2), '[translated] Changed')
  })

  it('shifts unaffected translations when lines are inserted', async () => {
    const lines = ['First', 'Middle', 'Last']
    const updates: Array<Map<number, string>> = []
    const orch = new TranslationOrchestrator(createMockDeps(lines, {
      onUpdate: decorations => updates.push(new Map(decorations)),
    }))

    await orch.translateRange(0, 3)
    lines.splice(1, 0, 'Inserted')
    orch.applyDocumentChanges([{ startLine: 1, endLine: 1, insertedLineBreaks: 1 }])

    const whileEditing = updates.at(-1)
    assert.equal(whileEditing?.get(0), '[translated] First')
    assert.equal(whileEditing?.get(3), '[translated] Last')
    assert.equal(whileEditing?.has(1), false)
    assert.equal(whileEditing?.has(2), false)

    await orch.translateRange(0, 4)
    assert.equal(updates.at(-1)?.get(1), '[translated] Inserted')
    assert.equal(updates.at(-1)?.get(2), '[translated] Middle')
    assert.equal(updates.at(-1)?.get(3), '[translated] Last')
  })

  it('discards an in-flight result after the document changes', async () => {
    const lines = ['Before']
    const requests: Array<{
      texts: string[];
      resolve: (results: string[]) => void;
    }> = []
    const updates: Array<Map<number, string>> = []
    const deps = createMockDeps(lines, {
      translateBatch: texts => new Promise(resolve => requests.push({ texts: [...texts], resolve })),
      onUpdate: decorations => updates.push(new Map(decorations)),
    })
    const orch = new TranslationOrchestrator(deps)

    const firstRun = orch.translateRange(0, 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepStrictEqual(requests[0].texts, ['Before'])

    lines[0] = 'After'
    orch.applyDocumentChanges([{ startLine: 0, endLine: 0, insertedLineBreaks: 0 }])
    const secondRun = orch.translateRange(0, 1)
    await new Promise(resolve => setImmediate(resolve))
    assert.deepStrictEqual(requests[1].texts, ['After'])

    requests[0].resolve(['stale translation'])
    await firstRun
    assert.equal(updates.some(update => update.get(0) === 'stale translation'), false)

    requests[1].resolve(['fresh translation'])
    await secondRun
    assert.equal(updates.at(-1)?.get(0), 'fresh translation')
  })
})
