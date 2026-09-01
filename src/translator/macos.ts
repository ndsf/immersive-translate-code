import { spawn } from 'node:child_process'
import { TranslationResult } from './types'

interface HelperInput {
  texts: string[];
  source: string;
  target: string;
}

interface HelperOutput {
  translations: string[];
  source: string;
  target: string;
}

export type MacOSHelperRunner = (helperPath: string, input: HelperInput) => Promise<HelperOutput>

function runHelper(helperPath: string, input: HelperInput): Promise<HelperOutput> {
  return new Promise((resolve, reject) => {
    const child = spawn(helperPath, [], { stdio: ['pipe', 'pipe', 'pipe'] })
    const stdout: Buffer[] = []
    const stderr: Buffer[] = []

    child.stdout.on('data', chunk => stdout.push(Buffer.from(chunk)))
    child.stderr.on('data', chunk => stderr.push(Buffer.from(chunk)))
    child.on('error', err => reject(new Error(`Unable to start macOS Translation helper: ${err.message}`)))
    child.on('close', code => {
      const errorText = Buffer.concat(stderr).toString('utf8').trim()
      if (code !== 0) {
        reject(new Error(errorText || `macOS Translation helper exited with code ${code}`))
        return
      }

      try {
        resolve(JSON.parse(Buffer.concat(stdout).toString('utf8')) as HelperOutput)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        reject(new Error(`Invalid response from macOS Translation helper: ${message}`))
      }
    })

    child.stdin.end(JSON.stringify(input))
  })
}

export class MacOSTranslator {
  constructor(
    private helperPath: string,
    private runner: MacOSHelperRunner = runHelper,
    private platform: NodeJS.Platform = process.platform,
  ) {}

  async translate(text: string, source: string, target: string): Promise<TranslationResult> {
    const [result] = await this.translateMany([text], source, target)
    return result
  }

  async translateMany(texts: string[], source: string, target: string): Promise<TranslationResult[]> {
    if (this.platform !== 'darwin') {
      throw new Error('Apple Translation provider is only available on macOS 26 or later.')
    }

    const output = await this.runner(this.helperPath, { texts, source, target })
    if (!Array.isArray(output.translations) || output.translations.length !== texts.length) {
      throw new Error(`macOS Translation returned ${output.translations?.length ?? 0} results for ${texts.length} inputs.`)
    }

    return output.translations.map(text => ({
      text,
      source: output.source || source,
      target: output.target || target,
      provider: 'macos',
    }))
  }
}
