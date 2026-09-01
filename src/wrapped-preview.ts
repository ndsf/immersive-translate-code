import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import * as vscode from 'vscode'

interface PreviewItem {
  line: number;
  source: string;
  translation: string;
  loading: boolean;
}

export class WrappedPreviewManager implements vscode.Disposable {
  private panels = new Map<string, vscode.WebviewPanel>()
  private latestItems = new Map<string, PreviewItem[]>()

  apply(editor: vscode.TextEditor, decorations: Map<number, string>, loading: Set<number>): void {
    const uri = editor.document.uri.toString()
    const panel = this.getOrCreatePanel(uri, editor.document.fileName)
    const lineNumbers = new Set([...decorations.keys(), ...loading])
    const items: PreviewItem[] = [...lineNumbers]
      .filter(line => line < editor.document.lineCount)
      .sort((a, b) => a - b)
      .map(line => ({
        line: line + 1,
        source: editor.document.lineAt(line).text,
        translation: decorations.get(line) ?? '',
        loading: loading.has(line),
      }))

    this.latestItems.set(uri, items)
    void panel.webview.postMessage({ type: 'update', items })
  }

  clear(uri: string): void {
    this.panels.get(uri)?.dispose()
    this.panels.delete(uri)
    this.latestItems.delete(uri)
  }

  clearAll(): void {
    for (const panel of this.panels.values()) { panel.dispose() }
    this.panels.clear()
    this.latestItems.clear()
  }

  dispose(): void {
    this.clearAll()
  }

  private getOrCreatePanel(uri: string, fileName: string): vscode.WebviewPanel {
    const existing = this.panels.get(uri)
    if (existing) { return existing }

    const panel = vscode.window.createWebviewPanel(
      'immersiveTranslateWrappedPreview',
      `Translation: ${path.basename(fileName)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    )
    panel.webview.html = this.getHtml(panel.webview)
    panel.webview.onDidReceiveMessage(message => {
      if (message?.type === 'ready') {
        void panel.webview.postMessage({ type: 'update', items: this.latestItems.get(uri) ?? [] })
      }
    })
    panel.onDidDispose(() => {
      this.panels.delete(uri)
      this.latestItems.delete(uri)
    })
    this.panels.set(uri, panel)
    return panel
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex')
    const csp = [
      "default-src 'none'",
      `style-src ${webview.cspSource} 'unsafe-inline'`,
      `script-src 'nonce-${nonce}'`,
    ].join('; ')

    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <style>
    body { margin: 0; color: var(--vscode-editor-foreground); background: var(--vscode-editor-background); font-family: var(--vscode-editor-font-family); font-size: var(--vscode-editor-font-size); }
    #content { padding: 0.75rem 1rem 2rem; }
    .item { display: grid; grid-template-columns: 3.5rem minmax(0, 1fr); gap: 0 0.75rem; padding: 0.5rem 0; border-bottom: 1px solid var(--vscode-editorWidget-border); }
    .line { grid-row: 1 / 3; color: var(--vscode-editorLineNumber-foreground); text-align: right; user-select: none; }
    .source, .translation { min-width: 0; white-space: pre-wrap; overflow-wrap: anywhere; word-break: break-word; }
    .source { color: var(--vscode-descriptionForeground); }
    .translation { margin-top: 0.25rem; font-style: italic; }
    .loading { color: var(--vscode-editorInlayHint-foreground); }
    .empty { color: var(--vscode-descriptionForeground); padding: 1rem 0; }
  </style>
</head>
<body>
  <main id="content"><div class="empty">Waiting for translations…</div></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const content = document.getElementById('content');
    window.addEventListener('message', event => {
      if (event.data?.type !== 'update') return;
      const items = event.data.items;
      content.replaceChildren();
      if (items.length === 0) {
        const empty = document.createElement('div');
        empty.className = 'empty';
        empty.textContent = 'No translatable lines in the current viewport.';
        content.append(empty);
        return;
      }
      for (const item of items) {
        const row = document.createElement('section');
        row.className = 'item';
        const line = document.createElement('div');
        line.className = 'line';
        line.textContent = item.line;
        const source = document.createElement('div');
        source.className = 'source';
        source.textContent = item.source;
        const translation = document.createElement('div');
        translation.className = item.loading && !item.translation ? 'translation loading' : 'translation';
        translation.textContent = item.translation || (item.loading ? '…' : '');
        row.append(line, source, translation);
        content.append(row);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
