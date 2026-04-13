// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const youtubeTranscriptSchema: ToolSchema = {
  name: 'youtube_transcript',
  description: `获取 YouTube 视频的字幕/文字稿。

支持的 URL 格式：
- https://www.youtube.com/watch?v=VIDEO_ID
- https://youtu.be/VIDEO_ID
- 直接提供 VIDEO_ID

**使用示例：**
\`\`\`
youtube_transcript { "url": "https://www.youtube.com/watch?v=dQw4w9WgXcQ" }
youtube_transcript { "url": "dQw4w9WgXcQ", "language": "zh" }
\`\`\`

**注意**：
- 只能获取已有字幕的视频
- 自动生成的字幕也可以获取
- 部分视频可能禁用字幕下载`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'YouTube 视频 URL 或 Video ID',
      },
      language: {
        type: 'string',
        description: '字幕语言代码（默认: en）',
      },
      text_only: {
        type: 'boolean',
        description: '仅返回纯文本（不含时间戳，默认 false）',
      },
    },
    required: ['url'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
