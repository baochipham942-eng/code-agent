// Schema-only file (P0-7 方案 A — single source of truth)
import type { ToolSchema } from '../../../protocol/tools';

export const RECOMMEND_CAPABILITY_DESCRIPTION = `诊断当前会话的能力缺口并给出补齐建议。

**何时调用：**
- 任务可能需要某种能力（例如图像生成、视觉分析、浏览器控制、长上下文）
  但你判断当前工具或主模型不一定具备时
- 用户提到"图片"、"截图"、"浏览器"、"PPT"、"长文档" 等触发词，且你不确定
  ToolSearch 是否能找到匹配工具时
- ToolSearch / 主模型调用失败，疑似是因为能力缺口（不是参数错误）

**何时不用：**
- 你已经明确知道用哪个工具时（直接调用即可）
- 错误是参数 / 权限问题，与能力本身无关时

工具返回结构化 Gap 列表（plugin/model/apikey 三类），调用方自主决策提示用户
或切换路径。`;

export const RECOMMEND_CAPABILITY_INPUT_SCHEMA = {
  type: 'object' as const,
  properties: {
    requiredCapability: {
      type: 'string',
      description: '需要的能力标签（kebab-case，例：image-generation / vision / browser-control / long-context）',
    },
    context: {
      type: 'string',
      description: '可选：任务上下文说明，帮助 recommender 给出更精确的建议',
    },
  },
  required: ['requiredCapability'],
};

export const recommendCapabilitySchema: ToolSchema = {
  name: 'recommend_capability',
  description: RECOMMEND_CAPABILITY_DESCRIPTION,
  inputSchema: RECOMMEND_CAPABILITY_INPUT_SCHEMA,
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: true,
};
