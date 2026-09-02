export type RichTextStyle = 'italic' | 'bold' | 'underline' | 'code' | 'comment'

export type RichTextNode = string | {
  style: RichTextStyle;
  children: RichTextNode[];
}

const STYLED_COMMANDS: Readonly<Record<string, RichTextStyle>> = {
  textit: 'italic',
  emph: 'italic',
  textsl: 'italic',
  textbf: 'bold',
  underline: 'underline',
  texttt: 'code',
}

const UNWRAPPED_COMMANDS = new Set(['text', 'textrm', 'textnormal', 'mbox'])
const ESCAPED_CHARACTERS = new Set(['%', '_', '&', '#', '$', '{', '}', '\\'])

interface ParseResult {
  nodes: RichTextNode[];
  next: number;
  closed: boolean;
}

function appendText(nodes: RichTextNode[], text: string): void {
  if (!text) { return }
  const last = nodes.at(-1)
  if (typeof last === 'string') {
    nodes[nodes.length - 1] = last + text
  } else {
    nodes.push(text)
  }
}

function appendNodes(nodes: RichTextNode[], additions: readonly RichTextNode[]): void {
  for (const node of additions) {
    if (typeof node === 'string') {
      appendText(nodes, node)
    } else {
      nodes.push(node)
    }
  }
}

function parseSequence(input: string, start: number, stopAtBrace: boolean): ParseResult {
  const nodes: RichTextNode[] = []
  let index = start

  while (index < input.length) {
    const character = input[index]
    if (character === '}' && stopAtBrace) {
      return { nodes, next: index + 1, closed: true }
    }

    if (character === '{') {
      const nested = parseSequence(input, index + 1, true)
      if (!nested.closed) {
        appendText(nodes, input.slice(index))
        return { nodes, next: input.length, closed: !stopAtBrace }
      }
      appendText(nodes, '{')
      appendNodes(nodes, nested.nodes)
      appendText(nodes, '}')
      index = nested.next
      continue
    }

    if (character !== '\\') {
      appendText(nodes, character)
      index++
      continue
    }

    const escaped = input[index + 1]
    if (escaped && ESCAPED_CHARACTERS.has(escaped)) {
      appendText(nodes, escaped)
      index += 2
      continue
    }

    let commandEnd = index + 1
    while (commandEnd < input.length && /[A-Za-z]/.test(input[commandEnd])) { commandEnd++ }
    const command = input.slice(index + 1, commandEnd)
    const normalizedCommand = command.toLowerCase()
    const style = STYLED_COMMANDS[normalizedCommand]
    const unwrap = UNWRAPPED_COMMANDS.has(normalizedCommand)
    if (!style && !unwrap) {
      const end = commandEnd > index + 1 ? commandEnd : index + 2
      appendText(nodes, input.slice(index, end))
      index = end
      continue
    }

    let brace = commandEnd
    while (brace < input.length && /\s/.test(input[brace])) { brace++ }
    if (input[brace] !== '{') {
      appendText(nodes, input.slice(index, commandEnd))
      index = commandEnd
      continue
    }

    const group = parseSequence(input, brace + 1, true)
    if (!group.closed) {
      appendText(nodes, input.slice(index))
      return { nodes, next: input.length, closed: !stopAtBrace }
    }
    if (style) {
      nodes.push({ style, children: group.nodes })
    } else {
      appendNodes(nodes, group.nodes)
    }
    index = group.next
  }

  return { nodes, next: index, closed: !stopAtBrace }
}

/** Parse a safe, deliberately small subset of LaTeX text-formatting commands. */
export function formatLatexTranslation(input: string): RichTextNode[] {
  const nodes = parseSequence(input, 0, false).nodes
  return input.trimStart().startsWith('%') ? [{ style: 'comment', children: nodes }] : nodes
}

/** Flatten formatted translation nodes for editor decoration content. */
export function richTextToPlainText(nodes: readonly RichTextNode[]): string {
  return nodes.map(node => typeof node === 'string' ? node : richTextToPlainText(node.children)).join('')
}

const MARKDOWN_SPECIAL_CHARACTERS = /([\\`*_[\]{}()#+.!|>~-])/g

function escapeMarkdownText(text: string): string {
  return text.replace(MARKDOWN_SPECIAL_CHARACTERS, '\\$1')
}

/** Convert the safe rich-text subset to MarkdownString content for hover UI. */
export function richTextToMarkdown(nodes: readonly RichTextNode[]): string {
  return nodes.map(node => {
    if (typeof node === 'string') { return escapeMarkdownText(node) }
    const content = richTextToMarkdown(node.children)
    switch (node.style) {
      case 'italic': return `*${content}*`
      case 'bold': return `**${content}**`
      case 'underline': return `_${content}_`
      case 'code': return `\`${content.replace(/`/g, '\\`')}\``
      case 'comment': return content.split('\n').map(line => `> ${line}`).join('\n')
    }
  }).join('')
}

export function richTextHasStyle(nodes: readonly RichTextNode[], style: RichTextStyle): boolean {
  return nodes.some(node => typeof node !== 'string' && (node.style === style || richTextHasStyle(node.children, style)))
}
