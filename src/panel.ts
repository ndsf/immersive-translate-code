import * as vscode from 'vscode'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildPanelLines } from './panel-content'

interface PanelState {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  lines: string[];
  requestRange: (start: number, end: number) => void;
}

export class TranslationPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelState>()

  open(document: vscode.TextDocument, requestRange: (start: number, end: number) => void): void {
    const uri = document.uri.toString()
    const existing = this.panels.get(uri)
    if (existing) {
      existing.document = document
      existing.requestRange = requestRange
      existing.panel.reveal(vscode.ViewColumn.Beside, true)
      this.postLines(existing)
      return
    }

    const panel = vscode.window.createWebviewPanel(
      'immersiveTranslateCode.translationPanel',
      `Translation: ${path.basename(document.fileName)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    )
    const state: PanelState = {
      panel,
      document,
      lines: Array.from({ length: document.lineCount }, () => ''),
      requestRange,
    }
    this.panels.set(uri, state)
    panel.webview.html = this.getHtml(panel.webview)

    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') { return }
      const data = message as { type?: string; start?: number; end?: number }
      if (data.type === 'ready') {
        this.postLines(state)
      } else if (data.type === 'requestRange' && Number.isInteger(data.start) && Number.isInteger(data.end)) {
        const start = Math.max(0, data.start ?? 0)
        const end = Math.min(state.document.lineCount, data.end ?? 0)
        if (start < end) { state.requestRange(start, end) }
      }
    })
    panel.onDidDispose(() => this.panels.delete(uri))
  }

  update(document: vscode.TextDocument, translations: ReadonlyMap<number, string>): void {
    const state = this.panels.get(document.uri.toString())
    if (!state) { return }
    state.document = document
    state.lines = buildPanelLines(document.lineCount, translations)
    this.postLines(state)
  }

  close(uri: string): void {
    this.panels.get(uri)?.panel.dispose()
  }

  closeAll(): void {
    const panels = [...this.panels.values()].map(state => state.panel)
    this.panels.clear()
    for (const panel of panels) { panel.dispose() }
  }

  dispose(): void {
    this.closeAll()
  }

  private postLines(state: PanelState): void {
    void state.panel.webview.postMessage({ type: 'translations', lines: state.lines })
  }

  private getHtml(webview: vscode.Webview): string {
    const nonce = randomBytes(16).toString('hex')
    return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'unsafe-inline'; script-src 'nonce-${nonce}';">
  <style>
    body {
      margin: 0;
      padding: 12px 16px;
      color: var(--vscode-editor-foreground);
      background: var(--vscode-editor-background);
      font-family: var(--vscode-editor-font-family);
      font-size: var(--vscode-editor-font-size);
      line-height: 1.5;
    }
    .line {
      min-height: 1.5em;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
  </style>
</head>
<body>
  <main id="translations"></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const root = document.getElementById('translations');
    let observer;
    let visible = new Set();
    let requestTimer;

    function requestVisibleRange() {
      clearTimeout(requestTimer);
      requestTimer = setTimeout(() => {
        if (visible.size === 0) return;
        const lines = [...visible];
        const start = Math.max(0, Math.min(...lines) - 20);
        const end = Math.max(...lines) + 41;
        vscode.postMessage({ type: 'requestRange', start, end });
      }, 100);
    }

    function render(lines) {
      const scrollTop = window.scrollY;
      observer?.disconnect();
      visible = new Set();
      root.replaceChildren(...lines.map((text, index) => {
        const line = document.createElement('div');
        line.className = 'line';
        line.dataset.line = String(index);
        line.textContent = text || '\u00a0';
        return line;
      }));
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const line = Number(entry.target.dataset.line);
          if (entry.isIntersecting) visible.add(line); else visible.delete(line);
        }
        requestVisibleRange();
      });
      for (const line of root.children) observer.observe(line);
      requestAnimationFrame(() => window.scrollTo(0, scrollTop));
    }

    window.addEventListener('message', event => {
      if (event.data?.type === 'translations' && Array.isArray(event.data.lines)) {
        render(event.data.lines);
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
