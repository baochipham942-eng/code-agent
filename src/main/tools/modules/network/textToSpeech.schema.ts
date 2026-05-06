// Schema-only file (P0-7 方案 A — single source of truth)
// text_to_speech — 字段与 legacy inputSchema 1:1 复刻
import type { ToolSchema } from '../../../protocol/tools';

const AVAILABLE_VOICES = [
  'female',
  '彤彤',
  '小陈',
  '锤锤',
  'jam',
  'kazi',
  'douji',
  'luodo',
];
const MAX_TEXT_LENGTH = 2000;

export const textToSpeechSchema: ToolSchema = {
  name: 'text_to_speech',
  description: `语音合成。

使用智谱 GLM-TTS 模型将文字转为语音。

参数：
- text: 要合成的文本（必填，最长 ${MAX_TEXT_LENGTH} 字符）
- output_path: 输出文件路径（可选，不填则返回 base64）
- voice: 声音类型（可选，默认 female）
- speed: 语速 0.5-2.0（可选，默认 1.0）
- volume: 音量 0.5-2.0（可选，默认 1.0）
- format: 输出格式 wav/pcm（可选，默认 wav）

可用声音：
- female: 默认女声
- 彤彤: 活泼女声
- 小陈: 成熟男声
- 锤锤: 可爱童声
- jam: 英文男声
- kazi: 英文女声
- douji: 方言男声
- luodo: 低沉男声

示例：
\`\`\`
text_to_speech { "text": "你好，欢迎使用语音合成" }
text_to_speech { "text": "Hello world", "voice": "jam", "output_path": "./hello.wav" }
text_to_speech { "text": "快速播报", "speed": 1.5, "voice": "小陈" }
\`\`\`

注意：需要配置智谱 API Key`,
  inputSchema: {
    type: 'object',
    properties: {
      text: {
        type: 'string',
        description: '要合成的文本',
      },
      output_path: {
        type: 'string',
        description: '输出文件路径（不填返回 base64）',
      },
      voice: {
        type: 'string',
        enum: AVAILABLE_VOICES,
        description: '声音类型（默认 female）',
      },
      speed: {
        type: 'number',
        description: '语速 0.5-2.0（默认 1.0）',
      },
      volume: {
        type: 'number',
        description: '音量 0.5-2.0（默认 1.0）',
      },
      format: {
        type: 'string',
        enum: ['wav', 'pcm'],
        description: '输出格式（默认 wav）',
      },
    },
    required: ['text'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
