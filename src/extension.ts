import * as vscode from 'vscode'
import * as path from 'node:path'
import { getConfig } from './config'
import { createTranslator } from './translator/factory'
import { parseNumberedResult } from './translator/parse'
import { TranslationCache, CacheStorage } from './cache'
import { TranslationOrchestrator, OrchestratorDeps } from './orchestrator'
import { DecorationManager } from './decorator'
import { TranslationPanelManager } from './panel'
import { initLogger, log } from './logger'

interface FileState {
  orchestrator: TranslationOrchestrator;
}

const fileStates = new Map<string, FileState>()
let cache: TranslationCache
let decorationManager: DecorationManager
let panelManager: TranslationPanelManager
let scrollListener: vscode.Disposable | undefined
let scrollDebounce: NodeJS.Timeout | undefined
const documentChangeDebounces = new Map<string, NodeJS.Timeout>()
let macosHelperPath: string

function createVSCodeCacheStorage(context: vscode.ExtensionContext): CacheStorage {
  const KEY = 'translationCache'
  return {
    get: () => context.globalState.get<Record<string, string>>(KEY),
    set: (data) => { context.globalState.update(KEY, data) },
  }
}

function buildDeps(editor: vscode.TextEditor): OrchestratorDeps {
  const config = getConfig()
  const { provider, sourceLanguage: src, targetLanguage: tgt } = config
  log('ext', `creating translator: provider=${provider} region=${config.awsRegion} model=${config.awsBedrockModelId}`)
  const translator = createTranslator({ ...config, macosHelperPath })
  const uri = editor.document.uri.toString()
  let errorReported = false

  const reportError = (err: unknown) => {
    const message = err instanceof Error ? err.message : String(err)
    log('ext', 'translation failed:', err as Error)
    if (!errorReported) {
      errorReported = true
      void vscode.window.showErrorMessage(`Immersive Translate (${provider}): ${message}`)
    }
  }

  return {
    getLineText: (ln) => editor.document.lineAt(ln).text,
    getLineCount: () => editor.document.lineCount,
    translateBatch: async (texts) => {
      log('ext', `translateBatch called: provider=${provider} count=${texts.length}`)
      if (translator.translateMany) {
        try {
          return (await translator.translateMany(texts, src, tgt)).map(result => result.text)
        } catch (err) {
          reportError(err)
          return texts.map(() => '')
        }
      }
      if (translator.translateBatch && texts.length > 1) {
        const merged = texts.map((t, i) => `[${i}] ${t}`).join('\n')
        try {
          const result = await translator.translateBatch(merged, src, tgt)
          log('ext', `LLM batch response:\n${result.text}`)
          const parsed = parseNumberedResult(result.text, texts.length)
          log('ext', `parse result: ${parsed ? 'OK' : 'FAILED'} (expected ${texts.length} lines)`)
          if (parsed) return parsed
        } catch (err) { log('ext', `batch call failed:`, err as Error) }
        log('ext', `falling back to line-by-line`)
      }
      return Promise.all(texts.map((t, i) =>
        translator.translate(t, src, tgt)
          .then(r => r.text)
          .catch((err) => {
            const preview = t.length > 80 ? `${t.slice(0, 80)}...` : t
            log('ext', `single translate failed [${i}] "${preview}":`, err as Error)
            reportError(err)
            return ''
          }),
      ))
    },
    onUpdate: (decorations, loading) => {
      panelManager.update(editor.document, decorations)
      const activeEditor = vscode.window.activeTextEditor
      if (activeEditor?.document.uri.toString() === uri) {
        decorationManager.apply(activeEditor, decorations, loading)
      }
    },
    cache,
    provider,
    sourceLanguage: src,
    targetLanguage: tgt,
  }
}

async function translateAndPersist(orch: TranslationOrchestrator, start: number, end: number): Promise<void> {
  const sizeBefore = cache.size
  await orch.translateRange(start, end)
  if (cache.size > sizeBefore) { cache.persist() }
}

function getViewportRange(editor: vscode.TextEditor): { start: number; end: number } | null {
  const visible = editor.visibleRanges[0]
  if (!visible) { return null }
  const size = visible.end.line - visible.start.line + 1
  return {
    start: visible.start.line,
    end: Math.min(visible.end.line + size, editor.document.lineCount),
  }
}

function clearDocumentChangeDebounce(uri: string): void {
  const timer = documentChangeDebounces.get(uri)
  if (timer) { clearTimeout(timer) }
  documentChangeDebounces.delete(uri)
}

function scheduleDocumentRefresh(event: vscode.TextDocumentChangeEvent): void {
  const document = event.document
  const uri = document.uri.toString()
  const state = fileStates.get(uri)
  if (!state || event.contentChanges.length === 0) { return }

  // Invalidate only edited lines. Existing translations outside the changed
  // ranges remain visible, and later line numbers are shifted as needed.
  state.orchestrator.applyDocumentChanges(event.contentChanges.map(change => ({
    startLine: change.range.start.line,
    endLine: change.range.end.line,
    insertedLineBreaks: change.text.split(/\r\n|\r|\n/).length - 1,
  })))

  clearDocumentChangeDebounce(uri)
  const timer = setTimeout(async () => {
    documentChangeDebounces.delete(uri)
    const currentState = fileStates.get(uri)
    const editor = vscode.window.visibleTextEditors.find(item => item.document.uri.toString() === uri)
    if (!currentState || !editor) { return }

    const range = getViewportRange(editor)
    if (!range) { return }
    await translateAndPersist(currentState.orchestrator, range.start, range.end)
  }, 350)
  documentChangeDebounces.set(uri, timer)
}

async function startImmersive(editor: vscode.TextEditor): Promise<void> {
  const uri = editor.document.uri.toString()

  // Reset existing state
  const existing = fileStates.get(uri)
  if (existing) {
    existing.orchestrator.reset()
    decorationManager.clear(editor)
  }

  const deps = buildDeps(editor)
  const orch = new TranslationOrchestrator(deps)
  fileStates.set(uri, { orchestrator: orch })

  // Set up scroll listener (shared across files)
  if (!scrollListener) {
    scrollListener = vscode.window.onDidChangeTextEditorVisibleRanges((e) => {
      const eUri = e.textEditor.document.uri.toString()
      const state = fileStates.get(eUri)
      if (!state) { return }
      // Entire file already translated — nothing more scroll can reveal.
      if (state.orchestrator.isComplete()) { return }

      if (scrollDebounce) { clearTimeout(scrollDebounce) }
      scrollDebounce = setTimeout(async () => {
        scrollDebounce = undefined
        // Re-check: file may have been stopped during the debounce window.
        const currentState = fileStates.get(eUri)
        if (!currentState) { return }
        const range = getViewportRange(e.textEditor)
        if (!range) { return }

        await translateAndPersist(currentState.orchestrator, range.start, range.end)
      }, 500)
    })
  }

  // Translate initial viewport
  const range = getViewportRange(editor)
  if (!range) { return }

  await translateAndPersist(orch, range.start, range.end)
}

function stopImmersive(editor: vscode.TextEditor): void {
  const uri = editor.document.uri.toString()
  panelManager.close(uri)
  clearDocumentChangeDebounce(uri)
  const state = fileStates.get(uri)
  if (state) {
    state.orchestrator.reset()
    fileStates.delete(uri)
  }
  decorationManager.clear(editor)

  // Clean up scroll listener if no files left
  if (fileStates.size === 0) {
    if (scrollDebounce) { clearTimeout(scrollDebounce); scrollDebounce = undefined }
    scrollListener?.dispose()
    scrollListener = undefined
  }
}

export function activate(context: vscode.ExtensionContext) {
  const outputChannel = initLogger()
  log('ext', 'extension activating')

  cache = new TranslationCache(createVSCodeCacheStorage(context))
  decorationManager = new DecorationManager()
  panelManager = new TranslationPanelManager()
  macosHelperPath = path.join(context.extensionPath, 'bin', 'macos-translation-helper')

  const toggleCmd = vscode.commands.registerCommand(
    'immersive-translate-code.toggle',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showWarningMessage('No active editor.')
        return
      }
      if (fileStates.has(editor.document.uri.toString())) {
        stopImmersive(editor)
      } else {
        await startImmersive(editor)
      }
    },
  )

  const resetCmd = vscode.commands.registerCommand(
    'immersive-translate-code.reset',
    () => {
      // Stop all active translations first
      for (const [uri, state] of fileStates) {
        state.orchestrator.reset()
        const editor = vscode.window.visibleTextEditors.find(e => e.document.uri.toString() === uri)
        if (editor) { decorationManager.clear(editor) }
      }
      fileStates.clear()
      panelManager.closeAll()
      for (const uri of documentChangeDebounces.keys()) { clearDocumentChangeDebounce(uri) }
      if (scrollDebounce) { clearTimeout(scrollDebounce); scrollDebounce = undefined }
      scrollListener?.dispose()
      scrollListener = undefined

      const count = cache.size
      cache.clear()
      vscode.window.showInformationMessage(`Translation cache cleared (${count} entries).`)
    },
  )

  const openPanelCmd = vscode.commands.registerCommand(
    'immersive-translate-code.openTranslationPanel',
    async () => {
      const editor = vscode.window.activeTextEditor
      if (!editor) {
        vscode.window.showWarningMessage('No active editor.')
        return
      }

      const uri = editor.document.uri.toString()
      panelManager.open(editor.document, (start, end) => {
        const state = fileStates.get(uri)
        if (state) { void translateAndPersist(state.orchestrator, start, end) }
      })

      let state = fileStates.get(uri)
      if (!state) {
        await startImmersive(editor)
        state = fileStates.get(uri)
      }
      state?.orchestrator.reapply()
    },
  )

  // Re-apply decorations when switching tabs
  const tabChangeListener = vscode.window.onDidChangeActiveTextEditor((editor) => {
    if (!editor) { return }
    const state = fileStates.get(editor.document.uri.toString())
    if (state) {
      state.orchestrator.reapply()
      const range = getViewportRange(editor)
      if (!state.orchestrator.isComplete() && range) {
        void translateAndPersist(state.orchestrator, range.start, range.end)
      }
    }
  })

  const documentChangeListener = vscode.workspace.onDidChangeTextDocument((event) => {
    scheduleDocumentRefresh(event)
  })

  context.subscriptions.push(toggleCmd, resetCmd, openPanelCmd, tabChangeListener, documentChangeListener, decorationManager, panelManager, outputChannel)
}

export function deactivate() {
  scrollListener?.dispose()
  panelManager?.dispose()
  for (const uri of documentChangeDebounces.keys()) { clearDocumentChangeDebounce(uri) }
  for (const state of fileStates.values()) {
    state.orchestrator.reset()
  }
  fileStates.clear()
}
