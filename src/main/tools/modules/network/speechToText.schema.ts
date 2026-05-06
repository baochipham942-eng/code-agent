// Schema-only file (P0-7 方案 A — single source of truth)
// speech_to_text — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

const SUPPORTED_FORMATS = ['.wav', '.mp3', '.m4a', '.flac', '.ogg', '.webm'];
const MAX_FILE_SIZE_MB = 25;
const MAX_DURATION_SECONDS = 30;

export const speechToTextSchema: ToolSchema = {
  name: 'speech_to_text',
  description: `语音转文字。

使用智谱 GLM-ASR-2512 模型将音频转为文字。

参数：
- file_path: 音频文件路径（必填）
- hotwords: 热词列表，用于提高特定词汇识别率（可选）
- prompt: 上下文提示，帮助模型理解内容（可选）

支持格式：${SUPPORTED_FORMATS.join(', ')}
限制：最大 ${MAX_FILE_SIZE_MB}MB，最长 ${MAX_DURATION_SECONDS} 秒

示例：
\`\`\`
speech_to_text { "file_path": "/path/to/audio.wav" }
speech_to_text { "file_path": "meeting.mp3", "hotwords": "智谱,GLM,API" }
speech_to_text { "file_path": "lecture.wav", "prompt": "这是一段关于人工智能的讲座" }
\`\`\`

注意：需要配置智谱 API Key`,
  inputSchema: {
    type: 'object',
    properties: {
      file_path: {
        type: 'string',
        description: '音频文件路径',
      },
      hotwords: {
        type: 'string',
        description: '热词列表，逗号分隔，用于提高特定词汇识别率',
      },
      prompt: {
        type: 'string',
        description: '上下文提示，帮助模型理解内容',
      },
    },
    required: ['file_path'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
