// ============================================================================
// builtin.audioProcessing — Step 5 第 1 个 builtin plugin（音频处理剥离）
//
// 与 host 同 bundle 编译/分发：speech_to_text + text_to_speech 都直接 import
// 宿主内部 API（configService / artifactMeta / MODEL_API_ENDPOINTS），仅工具
// 注册走 PluginAPI v2。
//
// 调用 `registerToolModule(module, { prefixWithPluginId: false })` 保留原工具名
// `speech_to_text` / `text_to_speech`，避免破坏 executionPhase 分类、ToolSearch
// deferredTools、LLM prompt / cache / eval baseline。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { speechToTextModule } from './speechToText';
import { textToSpeechModule } from './textToSpeech';

export const manifest: PluginManifest = {
  id: 'builtin.audioProcessing',
  name: 'Audio Processing',
  version: '1.0.0',
  description: '语音转文字 + 文字转语音（GLM-ASR / GLM-TTS）',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['audio-processing', 'speech-to-text', 'text-to-speech'],
  permissions: ['filesystem', 'network'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `speech_to_text` / `text_to_speech`
  api.registerToolModule(speechToTextModule, { prefixWithPluginId: false });
  api.registerToolModule(textToSpeechModule, { prefixWithPluginId: false });
  api.log(
    'info',
    `builtin.audioProcessing activated (tools: ${speechToTextModule.schema.name}, ${textToSpeechModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
