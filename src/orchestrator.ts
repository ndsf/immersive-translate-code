/**
 * TranslationOrchestrator — coordinates translation of visible lines.
 *
 * - Translates lines in batches (consecutive lines grouped together)
 * - Handles scroll: if user scrolls while translating, queues new range
 * - Uses cache to avoid re-translating
 * - All dependencies injected for testability
 */

import { TranslationCache } from './cache'
import { buildSkipLines, isTranslatable } from './filter'
import { log } from './logger'

export interface OrchestratorDeps {
  getLineText(lineNum: number): string;
  getLineCount(): number;
  translateBatch(texts: string[]): Promise<string[]>;
  onUpdate(decorations: Map<number, string>, loading: Set<number>): void;
  cache: TranslationCache;
  provider: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface DocumentLineChange {
  startLine: number;
  endLine: number;
  /** Number of line breaks in the inserted text. */
  insertedLineBreaks: number;
}

export const BATCH_SIZE = 5

/** Group consecutive numbers, then split into chunks of maxSize */
export function groupConsecutive(nums: number[], maxSize: number = BATCH_SIZE): number[][] {
  if (nums.length === 0) { return [] }

  const groups: number[][] = []
  let current: number[] = [nums[0]]

  for (let i = 1; i < nums.length; i++) {
    if (nums[i] === nums[i - 1] + 1) {
      current.push(nums[i])
    } else {
      groups.push(current)
      current = [nums[i]]
    }
  }
  groups.push(current)

  return groups.flatMap(group =>
    Array.from({ length: Math.ceil(group.length / maxSize) }, (_, i) =>
      group.slice(i * maxSize, (i + 1) * maxSize),
    ),
  )
}

export class TranslationOrchestrator {
  /** Lines that have been processed (translated or skipped) */
  private done = new Set<number>()
  /** Lines currently loading */
  private loading = new Set<number>()
  /** Line number -> translated text */
  private decorations = new Map<number, string>()
  /** Edited lines temporarily showing their previous translation. */
  private staleDecorations = new Set<number>()
  /** Skip lines cache per document version */
  private skipLines: Set<number> | null = null

  private running = false
  private pending: { start: number; end: number } | null = null
  /** Incremented whenever state is reset so stale async results can be discarded. */
  private generation = 0

  constructor(private deps: OrchestratorDeps) {}

  /** Request translation of lines [start, end). Queues if already running. */
  async translateRange(start: number, end: number): Promise<void> {
    if (this.running) {
      this.pending = { start, end }
      return
    }

    const generation = this.generation
    this.running = true
    try {
      let [s, e] = [start, end]
      while (true) {
        await this.processRange(s, e, generation)
        if (generation !== this.generation) { return }
        if (!this.pending) { break }
        [s, e] = [this.pending.start, this.pending.end]
        this.pending = null
      }
    } finally {
      if (generation === this.generation) { this.running = false }
    }
  }

  reapply(): void {
    this.notify()
  }

  /** True when every line in the document has been processed (translated or skipped). */
  isComplete(): boolean {
    return this.done.size >= this.deps.getLineCount()
  }

  reset(): void {
    this.generation++
    this.pending = null
    this.running = false
    this.done.clear()
    this.loading.clear()
    this.decorations.clear()
    this.staleDecorations.clear()
    this.skipLines = null
  }

  /**
   * Invalidate only lines touched by document edits while preserving and
   * shifting translations for unaffected lines.
   */
  applyDocumentChanges(changes: readonly DocumentLineChange[]): void {
    this.generation++
    this.pending = null
    this.running = false
    this.loading.clear()

    // VS Code change ranges refer to the document before the event. Applying
    // them bottom-up keeps every remaining range valid as line numbers shift.
    const ordered = [...changes].sort((a, b) =>
      b.startLine - a.startLine || b.endLine - a.endLine,
    )

    for (const change of ordered) {
      const newEndLine = change.startLine + change.insertedLineBreaks
      const lineDelta = newEndLine - change.endLine
      const previousTranslation = change.startLine === change.endLine && change.insertedLineBreaks === 0
        ? this.decorations.get(change.startLine)
        : undefined
      this.remapLineMap(this.decorations, change.startLine, change.endLine, lineDelta)
      this.remapLineSet(this.done, change.startLine, change.endLine, lineDelta)
      this.remapLineSet(this.staleDecorations, change.startLine, change.endLine, lineDelta)
      if (previousTranslation !== undefined) {
        this.decorations.set(change.startLine, previousTranslation)
        this.staleDecorations.add(change.startLine)
      }
    }

    this.skipLines = null
    this.notify()
  }

  invalidateSkipLines(): void {
    this.skipLines = null
  }

  private remapLineMap<T>(map: Map<number, T>, start: number, end: number, delta: number): void {
    const entries = [...map.entries()]
    map.clear()
    for (const [line, value] of entries) {
      if (line < start) {
        map.set(line, value)
      } else if (line > end) {
        map.set(line + delta, value)
      }
    }
  }

  private remapLineSet(set: Set<number>, start: number, end: number, delta: number): void {
    const lines = [...set]
    set.clear()
    for (const line of lines) {
      if (line < start) {
        set.add(line)
      } else if (line > end) {
        set.add(line + delta)
      }
    }
  }

  private getSkipLines(): Set<number> {
    this.skipLines ??= buildSkipLines(
      Array.from({ length: this.deps.getLineCount() }, (_, i) => this.deps.getLineText(i)),
    )
    return this.skipLines
  }

  private shouldTranslate(lineNum: number): boolean {
    if (this.getSkipLines().has(lineNum)) { return false }
    const text = this.deps.getLineText(lineNum)
    return isTranslatable(text)
  }

  private async processRange(start: number, end: number, generation: number): Promise<void> {
    if (generation !== this.generation) { return }
    const toTranslate: number[] = []
    let removedStaleDecoration = false
    for (let i = start; i < end; i++) {
      if (!this.done.has(i) && this.shouldTranslate(i)) {
        toTranslate.push(i)
      } else {
        if (!this.done.has(i) && this.staleDecorations.delete(i)) {
          removedStaleDecoration = this.decorations.delete(i) || removedStaleDecoration
        }
        this.done.add(i)
      }
    }

    if (removedStaleDecoration) { this.notify() }

    if (toTranslate.length === 0) {
      log('orch',`processRange(${start}, ${end}): nothing to translate`)
      return
    }

    log('orch',`processRange(${start}, ${end}): ${toTranslate.length} lines to translate`)

    // Show loading state
    for (const ln of toTranslate) {
      // Keep the previous translation visible while an edited line refreshes.
      if (!this.decorations.has(ln)) { this.loading.add(ln) }
    }
    this.notify()

    // Apple Translation is on-device and accepts batches directly. Use larger
    // batches for it so a full-document pass does not need to launch the
    // helper once for every five lines; remote providers keep the conservative
    // batch size used by their numbered-response parsers.
    const batchSize = this.deps.provider === 'macos' ? 50 : BATCH_SIZE
    const batches = groupConsecutive(toTranslate, batchSize)

    for (const batch of batches) {
      // Yield to new viewport if user scrolled
      if (this.pending) {
        log('orch',`pending detected, yielding. done=${this.done.size} decorations=${this.decorations.size}`)
        this.clearLoading(toTranslate)
        return
      }

      await this.translateBatch(batch, generation)
      if (generation !== this.generation) { return }
    }

    this.clearLoading(toTranslate)
  }

  private async translateBatch(lineNums: number[], generation: number): Promise<void> {
    const { cache, provider, sourceLanguage: src, targetLanguage: tgt } = this.deps

    const entries = lineNums.map(ln => {
      const text = this.deps.getLineText(ln).trim()
      const key = cache.buildKey(text, provider, src, tgt)
      return { ln, text, key, cached: cache.get(key) }
    })

    // Apply cached results immediately
    const uncached = entries.filter(e => {
      if (e.cached) {
        this.decorations.set(e.ln, e.cached)
        this.staleDecorations.delete(e.ln)
        this.done.add(e.ln)
        this.loading.delete(e.ln)
        return false
      }
      return true
    })

    log('orch',`batch lines [${lineNums.join(',')}]: ${entries.length - uncached.length} cached, ${uncached.length} to translate`)

    if (uncached.length > 0) {
      const results = await this.deps.translateBatch(uncached.map(e => e.text))
        .catch((err) => { log('orch',`translateBatch error:`, err); return uncached.map(() => '') })

      if (generation !== this.generation) {
        log('orch', 'discarding stale translation results after document change')
        return
      }

      log('orch',`batch results: [${results.map(r => r.slice(0, 20)).join(', ')}]`)

      uncached.forEach((e, i) => {
        const translated = results[i] ?? ''
        if (translated) {
          cache.set(e.key, translated)
          this.decorations.set(e.ln, translated)
          this.staleDecorations.delete(e.ln)
        } else {
          log('orch', `line ${e.ln} got empty translation (key=${e.key})`)
        }
        this.done.add(e.ln)
        this.loading.delete(e.ln)
      })
    }

    log('orch',`notify: decorations=${this.decorations.size} loading=${this.loading.size}`)
    this.notify()
  }

  private clearLoading(lines: number[]): void {
    if (lines.some(ln => this.loading.delete(ln))) { this.notify() }
  }

  private notify(): void {
    this.deps.onUpdate(this.decorations, this.loading)
  }
}
