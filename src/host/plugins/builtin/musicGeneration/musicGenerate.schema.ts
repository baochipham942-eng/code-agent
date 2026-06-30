// Schema-only file（single source of truth，mirror videoGenerate.schema）
// music_generate — agent 在"做音乐/配乐/写首歌/背景音乐"时调用，出片落 audio artifact。
import type { ToolSchema } from '../../../protocol/tools';

export const musicGenerateSchema: ToolSchema = {
  name: 'music_generate',
  description: `生成 AI 音乐。当用户想"做音乐 / 做配乐 / 写首歌 / 做一段背景音乐"时调用本工具。

根据文字描述（风格/情绪/乐器/场景）生成一段音乐，也可附歌词。生成结果是一个可播放的音频产物（MP3）。
注意：音乐生成为付费调用，请在用户确有音乐需求时再使用，不要重复试探。`,
  inputSchema: {
    type: 'object',
    properties: {
      prompt: {
        type: 'string',
        description: '音乐描述（风格 / 情绪 / 乐器 / 场景，支持中英文）',
      },
      lyrics: {
        type: 'string',
        description: '歌词（可选；不填则生成纯音乐）',
      },
      model: {
        type: 'string',
        description: '音乐模型 id（默认: minimax-music-2.6；桥接模型用 provider:model 形式）',
        default: 'minimax-music-2.6',
      },
      output_path: {
        type: 'string',
        description: '保存路径（不填则保存到工作目录 .code-agent/artifacts/music/）',
      },
    },
    required: ['prompt'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: false,
  allowInPlanMode: false,
};
