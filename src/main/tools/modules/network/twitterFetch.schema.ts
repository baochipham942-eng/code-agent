// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const twitterFetchSchema: ToolSchema = {
  name: 'twitter_fetch',
  description: `获取 Twitter/X 推文内容。

使用公开 API 获取推文文本、作者、互动数据等。

**使用示例：**
\`\`\`
twitter_fetch { "url": "https://twitter.com/elonmusk/status/1234567890" }
twitter_fetch { "url": "https://x.com/OpenAI/status/1234567890" }
\`\`\`

**注意**：
- 支持 twitter.com 和 x.com 链接
- 部分推文可能因隐私设置无法获取
- 图片/视频链接会一并返回`,
  inputSchema: {
    type: 'object',
    properties: {
      url: {
        type: 'string',
        description: 'Twitter/X 推文 URL',
      },
    },
    required: ['url'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
