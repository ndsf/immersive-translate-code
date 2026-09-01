# Immersive Translate - Code

Immersive translation for Visual Studio Code — displays inline translations alongside original text.

## Get Started

`Cmd+Shift+P` → `Immersive Translate: Toggle` (or `Ctrl+Cmd+T` on Mac / `Ctrl+Alt+T` on Win/Linux) — works out of the box (defaults to google-translate, no config needed).

Other providers:

- **On-device**: macos — Apple Translation on macOS 26+, no API key; translation runs locally (download language packs in System Settings first)
- **API key**: openai / deepseek / gemini, or custom for any OpenAI-compatible endpoint
- **AWS SSO**: bedrock — set region (required), profile, model ID

All settings: `Cmd+,` → search `immersive-translate`.

Translations stay inside the original editor. Hover a translated line to read the complete translation in a wrapped tooltip. VS Code currently does not word-wrap injected decoration text ([upstream issue](https://github.com/microsoft/vscode/issues/32856)).

While translation is enabled, editing existing text or adding/removing paragraphs automatically refreshes only the affected lines after a short debounce. Translations on untouched lines remain visible while you type.

## Development

```bash
pnpm install
```

F5 to launch.

## Acknowledgements

Inspired by [Immersive Translate](https://github.com/immersive-translate/immersive-translate/) and [vscode-immersive-translate-plugin](https://github.com/chengjingtao/vscode-immersive-translate-plugin).
