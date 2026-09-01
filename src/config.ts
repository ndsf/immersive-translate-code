import * as vscode from 'vscode'
import { Provider, TranslatorConfig } from './translator/factory'
import { DisplayMode } from './display-mode'

export interface TranslateConfig extends TranslatorConfig {
  sourceLanguage: string;
  targetLanguage: string;
  displayMode: DisplayMode;
}

const SECTION = 'immersive-translate-code'

export function getConfig(): TranslateConfig {
  const cfg = vscode.workspace.getConfiguration(SECTION)
  return {
    provider: cfg.get<Provider>('provider', 'google-translate'),
    apiKey: cfg.get<string>('apiKey', ''),
    baseURL: cfg.get<string>('baseURL', ''),
    model: cfg.get<string>('model', ''),
    awsRegion: cfg.get<string>('awsRegion', ''),
    awsProfile: cfg.get<string>('awsProfile', ''),
    awsBedrockModelId: cfg.get<string>('awsBedrockModelId', ''),
    sourceLanguage: cfg.get<string>('sourceLanguage', 'en'),
    targetLanguage: cfg.get<string>('targetLanguage', 'zh-CN'),
    displayMode: cfg.get<DisplayMode>('displayMode', 'auto'),
  }
}
