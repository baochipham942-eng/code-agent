import type { ToolSchema } from '../../../protocol/tools';

const target = {
  type: 'string',
  description: '任务 id、task_status 返回的序号、2-4 字短名或唯一标题片段。省略时只在当前恰好一件活跃任务时生效。',
} as const;

// 描述是路由契约，不是普通文案。ADR-059 后短小文件读写由文字前台直接完成；命令、联网、
// 等审批、多步骤与生成级长任务仍通过本工具进后台槽。schema 与 system prompt 必须保持一致，
// 否则模型会优先相信工具表和工具描述，重现「环境受限」类错误解释。
export const delegateTaskSchema: ToolSchema = {
  name: 'delegate_task',
  description: '需要运行命令、联网查证、等待审批、多步骤执行，或生成报告/网页等长任务时，调用本工具创建一个带完整工具面的后台任务。短小的本地文件读写由文字前台直接完成。accepted 只代表已接单，不代表完成。',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '用户可读的一句话任务标题。' },
      short_name: { type: 'string', description: '2-4 个字符的任务短名，中文或英文均可，例如「周报」「RR」。超过 4 字符时系统会稳定归一化。' },
      lane_key: { type: 'string', description: '目标或主题的稳定 lane；继续处理同一对象必须沿用。' },
      submission_key: { type: 'string', description: '当前 turn 内稳定的幂等键；同一次派发重试必须原样复用。' },
      prompt: { type: 'string', description: '给后台执行侧的完整自包含指令，保留用户原话中的目标、约束和验收要求。' },
      queue_when_full: { type: 'boolean', description: '只有用户在并发槽满后的 AskUserQuestion 中明确选择排队时才传 true。' },
    },
    required: ['title', 'short_name', 'lane_key', 'submission_key', 'prompt'],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'execute',
  allowInTextForeground: true,
  requiresPermission: false,
};

export const steerTaskSchema: ToolSchema = {
  name: 'steer_task',
  description: '给一件正在执行或排队的后台任务补充信息、修正要求或改变方向，不新开任务。',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      instruction: { type: 'string', description: '需要追进任务的完整新要求。' },
      target,
    },
    required: ['instruction'],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'execute',
  allowInTextForeground: true,
  requiresPermission: false,
};

export const cancelTaskSchema: ToolSchema = {
  name: 'cancel_task',
  description: '取消一件后台任务。目标不唯一时返回候选，随后必须用 AskUserQuestion 让用户按短名选择。',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: { target },
    required: [],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'execute',
  allowInTextForeground: true,
  requiresPermission: false,
};

export const taskStatusSchema: ToolSchema = {
  name: 'task_status',
  description: '读取当前会话后台任务的真实状态。用户追问进度、完成情况或有哪些活在跑时必须先调用。',
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'read',
  allowInTextForeground: true,
  requiresPermission: false,
  readOnly: true,
};
