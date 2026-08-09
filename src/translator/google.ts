import { TranslationService, TranslationResult } from './types'
import { log } from '../logger'

const GOOGLE_TRANSLATE_URL = 'https://translate.googleapis.com/translate_a/single'
const MAX_LOG_LEN = 500

function truncate(s: string, max = MAX_LOG_LEN): string {
  return s.length > max ? `${s.slice(0, max)}... (${s.length} chars total)` : s
}

export class GoogleTranslateTranslator implements TranslationService {
  async translate(text: string, source: string, target: string): Promise<TranslationResult> {
    const params = new URLSearchParams({
      client: 'gtx',
      sl: source,
      tl: target,
      dt: 't',
      q: text,
    })

    const url = `${GOOGLE_TRANSLATE_URL}?${params}`
    log('google', `request source=${source} target=${target} text=${truncate(text, 120)}`)
    log('google', `request url=${truncate(url)}`)

    let response: Response
    try {
      response = await fetch(url)
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err)
      log('google', 'network error:', err)
      throw new Error(`Google Translate network error: ${message}`)
    }

    log('google', `response status: ${response.status} ${response.statusText}`)

    const rawText = await response.text()
    log('google', `response body (${rawText.length} chars): ${truncate(rawText, 1000)}`)

    if (!response.ok) {
      throw new Error(`Google Translate HTTP ${response.status}: ${truncate(rawText, 200)}`)
    }

    let data: unknown
    try {
      data = JSON.parse(rawText)
    } catch (err) {
      log('google', 'JSON parse failed:', err)
      throw new Error(`Google Translate returned invalid JSON: ${truncate(rawText, 200)}`)
    }

    if (!Array.isArray(data) || !Array.isArray(data[0])) {
      log('google', 'unexpected response shape:', data)
      throw new Error(`Google Translate unexpected response shape: ${truncate(JSON.stringify(data), 200)}`)
    }

    const sentenceList = data[0] as unknown[]
    const translatedText = sentenceList
      .map((item: unknown, idx: number) => {
        if (!Array.isArray(item) || item.length === 0) {
          log('google', `sentence[${idx}] has unexpected shape:`, item)
          return ''
        }
        return String(item[0])
      })
      .join('')
    const detectedSource = (data[2] as string | undefined) || source

    log('google', `translated ${text.length} chars -> ${translatedText.length} chars, detectedSource=${detectedSource}`)

    return {
      text: translatedText,
      source: detectedSource,
      target,
      provider: 'google-translate',
    }
  }
}
