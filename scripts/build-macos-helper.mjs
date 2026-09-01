import { execFileSync } from 'node:child_process'
import { chmodSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = join(root, 'native', 'macos-translation-helper.swift')
const outputDir = join(root, 'bin')
const output = join(outputDir, 'macos-translation-helper')

if (process.platform !== 'darwin') {
  console.log('Skipping macOS translation helper build on non-macOS host.')
  process.exit(0)
}

mkdirSync(outputDir, { recursive: true })
const tempDir = mkdtempSync(join(tmpdir(), 'immersive-translate-helper-'))

try {
  const binaries = ['arm64', 'x86_64'].map(arch => {
    const binary = join(tempDir, `macos-translation-helper-${arch}`)
    execFileSync('xcrun', [
      'swiftc', source,
      '-O',
      '-parse-as-library',
      '-target', `${arch}-apple-macosx26.0`,
      '-o', binary,
    ], { stdio: 'inherit' })
    return binary
  })

  execFileSync('xcrun', ['lipo', '-create', ...binaries, '-output', output], { stdio: 'inherit' })
  execFileSync('codesign', ['--force', '--sign', '-', output], { stdio: 'inherit' })
  chmodSync(output, 0o755)
  console.log(`Built universal macOS translation helper: ${output}`)
} finally {
  rmSync(tempDir, { recursive: true, force: true })
}
