import * as vscode from 'vscode'
import * as path from 'node:path'
import { randomBytes } from 'node:crypto'
import { buildPanelLines } from './panel-content'
import { RichTextNode } from './latex-format'

interface PanelState {
  panel: vscode.WebviewPanel;
  document: vscode.TextDocument;
  lines: RichTextNode[][];
  anchorLine: number;
  requestRange: (start: number, end: number) => void;
  revealSourceLine: (line: number) => void;
}

export class TranslationPanelManager implements vscode.Disposable {
  private readonly panels = new Map<string, PanelState>()

  open(
    document: vscode.TextDocument,
    requestRange: (start: number, end: number) => void,
    revealSourceLine: (line: number) => void,
  ): void {
    const uri = document.uri.toString()
    const existing = this.panels.get(uri)
    if (existing) {
      existing.document = document
      existing.requestRange = requestRange
      existing.revealSourceLine = revealSourceLine
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
      lines: Array.from({ length: document.lineCount }, (): RichTextNode[] => []),
      anchorLine: 0,
      requestRange,
      revealSourceLine,
    }
    this.panels.set(uri, state)
    panel.webview.html = this.getHtml(panel.webview)

    panel.webview.onDidReceiveMessage((message: unknown) => {
      if (!message || typeof message !== 'object') { return }
      const data = message as { type?: string; start?: number; end?: number }
      if (data.type === 'ready') {
        this.postLines(state)
        this.postRevealLine(state)
      } else if (data.type === 'requestRange' && Number.isInteger(data.start) && Number.isInteger(data.end)) {
        const start = Math.max(0, data.start ?? 0)
        const end = Math.min(state.document.lineCount, data.end ?? 0)
        if (start < end) { state.requestRange(start, end) }
      } else if (data.type === 'scrollLine' && Number.isInteger(data.start)) {
        const line = Math.max(0, Math.min(state.document.lineCount - 1, data.start ?? 0))
        state.revealSourceLine(line)
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

  revealLine(uri: string, line: number): void {
    const state = this.panels.get(uri)
    if (!state) { return }
    const clamped = Math.max(0, Math.min(state.document.lineCount - 1, line))
    state.anchorLine = clamped
    this.postRevealLine(state)
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

  private postRevealLine(state: PanelState): void {
    void state.panel.webview.postMessage({ type: 'revealLine', line: state.anchorLine })
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
    let scrollTimer;
    let suppressScrollUntil = 0;
    let anchorLine = 0;
    let syncReady = false;
    let lastScrollTop = window.scrollY;

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

    function reportScrollLine() {
      clearTimeout(scrollTimer);
      scrollTimer = setTimeout(() => {
        if (!syncReady || Date.now() < suppressScrollUntil || visible.size === 0) return;
        const line = Math.min(...visible);
        if (line === anchorLine) return;
        anchorLine = line;
        vscode.postMessage({ type: 'scrollLine', start: anchorLine });
      }, 50);
    }

    function handleScroll() {
      lastScrollTop = window.scrollY;
      reportScrollLine();
    }

    function appendRichText(parent, nodes) {
      const tags = { italic: 'em', bold: 'strong', underline: 'u', code: 'code' };
      for (const node of nodes) {
        if (typeof node === 'string') {
          parent.append(document.createTextNode(node));
          continue;
        }
        const tag = tags[node?.style];
        if (!tag || !Array.isArray(node.children)) continue;
        const element = document.createElement(tag);
        appendRichText(element, node.children);
        parent.append(element);
      }
    }

    function render(lines) {
      observer?.disconnect();
      visible = new Set();
      root.replaceChildren(...lines.map((nodes, index) => {
        const line = document.createElement('div');
        line.className = 'line';
        line.dataset.line = String(index);
        if (Array.isArray(nodes) && nodes.length > 0) {
          appendRichText(line, nodes);
        } else {
          line.textContent = '\u00a0';
        }
        return line;
      }));
      observer = new IntersectionObserver(entries => {
        for (const entry of entries) {
          const line = Number(entry.target.dataset.line);
          if (entry.isIntersecting) visible.add(line); else visible.delete(line);
        }
        requestVisibleRange();
        if (Math.abs(window.scrollY - lastScrollTop) > 1) {
          lastScrollTop = window.scrollY;
          reportScrollLine();
        }
      });
      for (const line of root.children) observer.observe(line);
      requestAnimationFrame(() => {
        const anchor = root.children[anchorLine];
        if (anchor) {
          suppressScrollUntil = Date.now() + 300;
          anchor.scrollIntoView({ block: 'start' });
          lastScrollTop = window.scrollY;
        }
      });
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });

    window.addEventListener('message', event => {
      if (event.data?.type === 'translations' && Array.isArray(event.data.lines)) {
        render(event.data.lines);
      } else if (event.data?.type === 'revealLine' && Number.isInteger(event.data.line)) {
        const line = root.children[event.data.line];
        anchorLine = event.data.line;
        syncReady = true;
        if (line) {
          suppressScrollUntil = Date.now() + 300;
          line.scrollIntoView({ block: 'start' });
          lastScrollTop = window.scrollY;
        }
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
