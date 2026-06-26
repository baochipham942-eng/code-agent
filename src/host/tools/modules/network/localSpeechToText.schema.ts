// Schema-only file (P0-7 方案 A — single source of truth)
// local_speech_to_text — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

const SUPPORTED_FORMATS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm', '.aac', '.wma'];

export const localSpeechToTextSchema: ToolSchema = {
  name: 'local_speech_to_text',
  description: `本地离线语音转文字。

使用 whisper-cpp 在本地运行语音识别，无需网络，支持多种语言。

参数：
- file_path: 音频文件路径（必填）
- language: 语言代码，如 zh/en/ja（可选，默认 zh）
- model: 模型名称（可选，默认 large-v3-turbo）
- threads: CPU 线程数（可选，默认 4）
- output_format: 输出格式 text/srt/vtt（可选，默认 text）
- translate: 是否翻译为英文（可选）

支持格式：${SUPPORTED_FORMATS.join(', ')}
非 WAV 格式会自动通过 ffmpeg 转换。

前置要求：
- brew install whisper-cpp
- 模型文件放置于 ~/.cache/whisper/

示例：
\`\`\`
local_speech_to_text { "file_path": "/path/to/audio.wav" }
local_speech_to_text { "file_path": "meeting.mp3", "language": "en", "output_format": "srt" }
\`\`\``,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '音频文件路径',
      },
      language: {
        type: 'string',
        description: '语言代码（如 zh, en, ja），默认 zh',
      },
      model: {
        type: 'string',
        description: '模型名称，默认 large-v3-turbo',
      },
      threads: {
        type: 'number',
        description: 'CPU 线程数，默认 4',
      },
      output_format: {
        type: 'string',
        enum: ['text', 'srt', 'vtt'],
        description: '输出格式，默认 text',
      },
      translate: {
        type: 'boolean',
        description: '是否翻译为英文',
      },
    },
    required: ['file_path'],
  },
  category: 'network',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
