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
    restoredPanel?: vscode.WebviewPanel,
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

    const panel = restoredPanel ?? vscode.window.createWebviewPanel(
      'immersiveTranslateCode.translationPanel',
      `Translation: ${path.basename(document.fileName)}`,
      { viewColumn: vscode.ViewColumn.Beside, preserveFocus: true },
      { enableScripts: true, retainContextWhenHidden: true },
    )
    panel.title = `Translation: ${path.basename(document.fileName)}`
    panel.webview.options = { enableScripts: true }
    const state: PanelState = {
      panel,
      document,
      lines: Array.from({ length: document.lineCount }, (): RichTextNode[] => []),
      anchorLine: 0,
      requestRange,
      revealSourceLine,
    }
    this.panels.set(uri, state)

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
    // Install the message listener before assigning HTML. A restored webview
    // can start executing immediately; registering first guarantees its
    // initial `ready` message is not lost.
    panel.webview.html = this.getHtml(panel.webview, document.uri.toString())
  }

  update(document: vscode.TextDocument, translations: ReadonlyMap<number, string>): void {
    const state = this.panels.get(document.uri.toString())
    if (!state) { return }
    state.document = document
    const commentLines = new Set<number>()
    for (let line = 0; line < document.lineCount; line++) {
      if (document.lineAt(line).text.trimStart().startsWith('%')) {
        commentLines.add(line)
      }
    }
    state.lines = buildPanelLines(document.lineCount, translations, commentLines)
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
    const sourceLines = Array.from({ length: state.document.lineCount }, (_, line) => state.document.lineAt(line).text)
    const wordWrap = vscode.workspace
      .getConfiguration('editor', state.document.uri)
      .get<string>('wordWrap', 'off') !== 'off'
    void state.panel.webview.postMessage({ type: 'translations', lines: state.lines, sourceLines, wordWrap })
  }

  private postRevealLine(state: PanelState): void {
    void state.panel.webview.postMessage({ type: 'revealLine', line: state.anchorLine })
  }

  private getHtml(webview: vscode.Webview, documentUri: string): string {
    const nonce = randomBytes(16).toString('hex')
    const serializedDocumentUri = JSON.stringify(documentUri)
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
      display: grid;
      grid-template-columns: minmax(2.5em, max-content) minmax(0, 1fr);
      column-gap: 1em;
      align-items: start;
      min-height: 1.5em;
    }
    .line-content {
      min-width: 0;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
    }
    .line-number {
      color: var(--vscode-editorLineNumber-foreground);
      text-align: right;
      user-select: none;
      font-variant-numeric: tabular-nums;
    }
    .source-measure {
      position: absolute;
      visibility: hidden;
      pointer-events: none;
      white-space: pre-wrap;
      overflow-wrap: anywhere;
      line-height: inherit;
      width: 100%;
    }
    .comment {
      color: var(--vscode-descriptionForeground);
      font-style: italic;
    }
    .heading {
      display: block;
      font-weight: 600;
      margin: 0.35em 0 0.15em;
    }
    .heading-1 { font-size: 1.45em; }
    .heading-2 { font-size: 1.3em; }
    .heading-3 { font-size: 1.15em; }
    .heading-4, .heading-5, .heading-6 { font-size: 1.05em; }
    .citation {
      color: var(--vscode-textLink-foreground);
    }
    .citation::before { content: '['; }
    .citation::after { content: ']'; }
    .list-item {
      display: list-item;
      list-style-position: outside;
      margin-left: 1.5em;
    }
  </style>
</head>
<body>
  <main id="translations"></main>
  <script nonce="${nonce}">
    const vscode = acquireVsCodeApi();
    const previousState = vscode.getState() || {};
    vscode.setState({ ...previousState, documentUri: ${serializedDocumentUri} });
    const root = document.getElementById('translations');
    let observer;
    let visible = new Set();
    let requestTimer;
    let scrollFrame;
    let scrollAnimationFrame;
    let scrollAnimationToken = 0;
    let programmaticScroll = false;
    let suppressScrollUntil = 0;
    let anchorLine = 0;
    let syncReady = false;
    let revealPending = true;
    let hasRendered = false;
    let lastViewport;
    let lastScrollTop = window.scrollY;
    let sourceLines = [];
    let sourceWordWrap = false;
    let resizeFrame;

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
      if (scrollFrame !== undefined) return;
      scrollFrame = requestAnimationFrame(() => {
        scrollFrame = undefined;
        if (programmaticScroll || !syncReady || Date.now() < suppressScrollUntil || visible.size === 0) return;
        const line = Math.min(...visible);
        if (line === anchorLine) return;
        anchorLine = line;
        vscode.postMessage({ type: 'scrollLine', start: anchorLine });
      });
    }

    function handleScroll() {
      lastScrollTop = window.scrollY;
      const viewport = captureViewport();
      if (viewport) lastViewport = viewport;
      if (!programmaticScroll) reportScrollLine();
    }

    function cancelScrollAnimation() {
      scrollAnimationToken += 1;
      if (scrollAnimationFrame !== undefined) {
        cancelAnimationFrame(scrollAnimationFrame);
        scrollAnimationFrame = undefined;
      }
      programmaticScroll = false;
    }

    function getLineScrollTop(element) {
      return Math.max(0, element.getBoundingClientRect().top + window.scrollY - 12);
    }

    function scrollToLine(lineNumber, smooth) {
      const element = root.children[lineNumber];
      if (!element) return false;
      const target = getLineScrollTop(element);
      if (!smooth || Math.abs(target - window.scrollY) < 1) {
        cancelScrollAnimation();
        window.scrollTo(0, target);
        lastScrollTop = window.scrollY;
        return true;
      }

      cancelScrollAnimation();
      const token = scrollAnimationToken;
      const start = window.scrollY;
      const distance = target - start;
      const startedAt = performance.now();
      const duration = 100;
      programmaticScroll = true;
      const step = (now) => {
        if (token !== scrollAnimationToken) return;
        const progress = Math.min(1, (now - startedAt) / duration);
        const eased = 1 - Math.pow(1 - progress, 3);
        window.scrollTo(0, start + distance * eased);
        lastScrollTop = window.scrollY;
        suppressScrollUntil = Date.now() + 140;
        if (progress < 1) {
          scrollAnimationFrame = requestAnimationFrame(step);
        } else {
          scrollAnimationFrame = undefined;
          programmaticScroll = false;
          suppressScrollUntil = Date.now() + 80;
        }
      };
      scrollAnimationFrame = requestAnimationFrame(step);
      return true;
    }

    function captureViewport() {
      if (!syncReady || visible.size === 0) return null;
      const line = Math.min(...visible);
      const element = root.children[line];
      if (!element) return null;
      return { line, top: element.getBoundingClientRect().top };
    }

    function restoreViewport(snapshot) {
      if (!snapshot) return false;
      const element = root.children[snapshot.line];
      if (!element) return false;
      const delta = element.getBoundingClientRect().top - snapshot.top;
      if (Math.abs(delta) > 0.5) {
        suppressScrollUntil = Date.now() + 300;
        window.scrollBy(0, delta);
      }
      lastScrollTop = window.scrollY;
      return true;
    }

    function updateSourceLineHeights() {
      if (!sourceWordWrap || sourceLines.length !== root.children.length || root.children.length === 0) {
        for (const line of root.children) line.style.minHeight = '';
        return;
      }

      const measure = document.createElement('div');
      measure.className = 'source-measure';
      const content = root.children[0].querySelector('.line-content');
      measure.style.width = (content?.clientWidth || root.clientWidth) + 'px';
      document.body.append(measure);
      const lineHeight = parseFloat(getComputedStyle(content || root.children[0]).lineHeight) || 1;
      for (let index = 0; index < root.children.length; index++) {
        measure.textContent = sourceLines[index] || '\u00a0';
        const sourceHeight = Math.max(lineHeight, measure.getBoundingClientRect().height);
        root.children[index].style.minHeight = sourceHeight + 'px';
      }
      measure.remove();
    }

    function appendRichText(parent, nodes) {
      const tags = {
        italic: 'em', bold: 'strong', underline: 'u', code: 'code', comment: 'span',
        heading: 'div', citation: 'span', listItem: 'span',
      };
      for (const node of nodes) {
        if (typeof node === 'string') {
          parent.append(document.createTextNode(node));
          continue;
        }
        const tag = tags[node?.style];
        if (!tag || !Array.isArray(node.children)) continue;
        const element = document.createElement(tag);
        if (node.style === 'comment') element.className = 'comment';
        if (node.style === 'heading') {
          const level = Number.isInteger(node.level) ? Math.max(1, Math.min(6, node.level)) : 2;
          element.className = 'heading heading-' + level;
        }
        if (node.style === 'citation') element.className = 'citation';
        if (node.style === 'listItem') element.className = 'list-item';
        appendRichText(element, node.children);
        parent.append(element);
      }
    }

    function render(lines) {
      const viewport = hasRendered && !revealPending
        ? (captureViewport() || lastViewport)
        : null;
      if (viewport) lastViewport = viewport;
      cancelScrollAnimation();
      hasRendered = true;
      observer?.disconnect();
      visible = new Set();
      root.replaceChildren(...lines.map((nodes, index) => {
        const line = document.createElement('div');
        line.className = 'line';
        line.dataset.line = String(index);
        const lineNumber = document.createElement('span');
        lineNumber.className = 'line-number';
        lineNumber.textContent = String(index + 1);
        lineNumber.setAttribute('aria-hidden', 'true');
        const content = document.createElement('div');
        content.className = 'line-content';
        if (Array.isArray(nodes) && nodes.length > 0) {
          appendRichText(content, nodes);
        } else {
          content.textContent = '\u00a0';
        }
        line.append(lineNumber, content);
        return line;
      }));
      updateSourceLineHeights();
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
        if (!revealPending && restoreViewport(viewport)) return;
        const anchor = root.children[anchorLine];
        if (anchor) {
          suppressScrollUntil = Date.now() + 300;
          scrollToLine(anchorLine, false);
          revealPending = false;
        }
      });
    }

    window.addEventListener('scroll', handleScroll, { passive: true });
    document.addEventListener('scroll', handleScroll, { passive: true, capture: true });
    window.addEventListener('resize', () => {
      if (resizeFrame !== undefined) return;
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = undefined;
        const viewport = captureViewport();
        updateSourceLineHeights();
        restoreViewport(viewport);
      });
    });

    window.addEventListener('message', event => {
      if (event.data?.type === 'translations' && Array.isArray(event.data.lines)) {
        sourceLines = Array.isArray(event.data.sourceLines) ? event.data.sourceLines : [];
        sourceWordWrap = event.data.wordWrap === true;
        render(event.data.lines);
      } else if (event.data?.type === 'revealLine' && Number.isInteger(event.data.line)) {
        const line = root.children[event.data.line];
        const wasRevealPending = revealPending;
        const shouldAnimate = hasRendered && !wasRevealPending;
        const sameAnchor = event.data.line === anchorLine;
        anchorLine = event.data.line;
        syncReady = true;
        revealPending = !line;
        if (line) {
          if (sameAnchor && !wasRevealPending) return;
          lastViewport = null;
          scrollToLine(event.data.line, shouldAnimate);
        }
      }
    });
    vscode.postMessage({ type: 'ready' });
  </script>
</body>
</html>`
  }
}
