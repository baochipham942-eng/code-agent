// ============================================================================
// builtin.audioProcessing — TTS only (ASR 收敛到 local_speech_to_text)
//
// speech_to_text (云端 GLM-ASR-2512) 已下线: 原始音频不应进云端 LLM。
// LLM 需要 ASR 时统一走 local_speech_to_text (whisper-cpp + ggml-large-v3-turbo,
// 本地推理)。voicePaste/desktopAudioCapture 也走本地 whisper-cpp。
//
// 文字转语音保留: TTS 出方向不涉及用户隐私语料上行。
// ============================================================================

import type { PluginAPI, PluginEntry, PluginManifest } from '../../types';
import { textToSpeechModule } from './textToSpeech';

export const manifest: PluginManifest = {
  id: 'builtin.audioProcessing',
  name: 'Audio Processing',
  version: '1.1.0',
  description: '文字转语音（GLM-TTS）。ASR 走 local_speech_to_text 本地路径。',
  author: 'Agent Neo',
  main: 'index.ts',
  surfaces: ['tools'],
  capabilities: ['audio-processing', 'text-to-speech'],
  permissions: ['filesystem', 'network'],
};

export async function activate(api: PluginAPI): Promise<void> {
  // opt-out 前缀：保留原工具名 `text_to_speech`
  api.registerToolModule(textToSpeechModule, { prefixWithPluginId: false });
  api.log(
    'info',
    `builtin.audioProcessing activated (tools: ${textToSpeechModule.schema.name})`,
  );
}

const entry: PluginEntry = { activate };
export default entry;
