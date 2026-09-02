export type RichTextStyle =
  | 'italic'
  | 'bold'
  | 'underline'
  | 'code'
  | 'comment'
  | 'heading'
  | 'citation'
  | 'listItem'

export type RichTextNode = string | {
  style: RichTextStyle;
  children: RichTextNode[];
  level?: number;
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
const HEADING_COMMANDS: Readonly<Record<string, number>> = {
  chapter: 1,
  section: 2,
  subsection: 3,
  subsubsection: 4,
  paragraph: 5,
  subparagraph: 6,
}
const CITATION_COMMANDS = new Set(['cite', 'citep', 'citet', 'citeauthor', 'citeyear'])
const LIST_ENVIRONMENTS = new Set(['itemize', 'enumerate', 'description'])
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
    const headingLevel = HEADING_COMMANDS[normalizedCommand]
    const citation = CITATION_COMMANDS.has(normalizedCommand)
    const environment = normalizedCommand === 'begin' || normalizedCommand === 'end'
    const listItem = normalizedCommand === 'item'
    const hasHeadingStar = headingLevel !== undefined && input[commandEnd] === '*'

    if (!style && !unwrap && headingLevel === undefined && !citation && !environment && !listItem) {
      const end = commandEnd > index + 1 ? commandEnd : index + 2
      appendText(nodes, input.slice(index, end))
      index = end
      continue
    }

    if (listItem) {
      let itemStart = commandEnd
      // Optional labels (e.g. \item[Step 1]) are presentation metadata; the
      // translated item body is what should be shown in the panel.
      if (input[itemStart] === '[') {
        const labelEnd = input.indexOf(']', itemStart + 1)
        if (labelEnd >= 0) { itemStart = labelEnd + 1 }
      }
      while (itemStart < input.length && /[ \t]/.test(input[itemStart])) { itemStart++ }
      const item = parseSequence(input, itemStart, stopAtBrace)
      nodes.push({ style: 'listItem', children: item.nodes })
      return { nodes, next: item.next, closed: item.closed }
    }

    let brace = commandEnd + (hasHeadingStar ? 1 : 0)
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
    if (environment) {
      const environmentName = richTextToPlainText(group.nodes).trim().toLowerCase()
      if (LIST_ENVIRONMENTS.has(environmentName)) {
        index = group.next
        while (index < input.length && /[ \t]/.test(input[index])) { index++ }
        continue
      }
      appendText(nodes, input.slice(index, group.next))
    } else if (headingLevel !== undefined) {
      nodes.push({ style: 'heading', level: headingLevel, children: group.nodes })
    } else if (citation) {
      nodes.push({ style: 'citation', children: group.nodes })
    } else if (style) {
      nodes.push({ style, children: group.nodes })
    } else {
      appendNodes(nodes, group.nodes)
    }
    index = group.next
  }

  return { nodes, next: index, closed: !stopAtBrace }
}

/** Parse a safe, deliberately small subset of LaTeX text-formatting commands. */
export function formatLatexTranslation(input: string, commentLine?: boolean): RichTextNode[] {
  const nodes = parseSequence(input, 0, false).nodes
  // Keep the output-based fallback for callers that do not have the source
  // line (or when a provider itself preserves the percent marker), while also
  // allowing the source line to force comment styling when the marker is lost.
  const isComment = Boolean(commentLine) || input.trimStart().startsWith('%')
  return isComment ? [{ style: 'comment', children: nodes }] : nodes
}

/** Flatten formatted translation nodes for editor decoration content. */
export function richTextToPlainText(nodes: readonly RichTextNode[]): string {
  return nodes.map(node => typeof node === 'string' ? node : richTextToPlainText(node.children)).join('')
}

/** Flatten nodes with the markers needed by a single inline editor decoration. */
export function richTextToDisplayText(nodes: readonly RichTextNode[]): string {
  return nodes.map(node => {
    if (typeof node === 'string') { return node }
    const content = richTextToDisplayText(node.children)
    switch (node.style) {
      case 'citation': return `[${content}]`
      case 'listItem': return `• ${content}`
      default: return content
    }
  }).join('')
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
      case 'heading': return `**${content}**`
      case 'citation': return `[${content}]`
      case 'listItem': return `- ${content}`
    }
  }).join('')
}

export function richTextHasStyle(nodes: readonly RichTextNode[], style: RichTextStyle): boolean {
  return nodes.some(node => typeof node !== 'string' && (node.style === style || richTextHasStyle(node.children, style)))
}
