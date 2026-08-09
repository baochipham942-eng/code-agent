import type { ToolSchema } from '../../../protocol/tools';

const target = {
  type: 'string',
  description: '任务 id、task_status 返回的序号、2-4 字短名或唯一标题片段。省略时只在当前恰好一件活跃任务时生效。',
} as const;

// 描述是这个工具的承重件，不是文案。真机实测（ADR-056 对照组 FAIL）：只把「写请求请派活」
// 写进系统提示词时，模型读 tool schema 推出「我只有只读工具」，宁可回复「Edit/Write/Bash 均被
// 禁用」也不调这里——function calling 微调把工具表训成了能力边界的权威信号，system prompt
// 与 schema 冲突时模型信 schema。竞品一致做法是把路由契约写进工具 description
// （Zed 的 create_thread、Cline 的 switch_to_act_mode、Claude Code 的 ExitPlanMode 同理），
// 且以「产出什么」命名而非「管理什么」。改这段前先读
// docs 侧的竞品对照结论，别改回「把一件工作交给后台任务」那种任务调度口吻。
export const delegateTaskSchema: ToolSchema = {
  name: 'delegate_task',
  description: '只读前台里创建、修改、删除、重命名文件，运行命令，联网查证，或任何会改变工作区的请求，唯一的受理方式就是调用本工具——包括你本轮已经读过文件之后。它不在前台执行任何副作用，而是创建一个带完整写工具的后台任务去做。accepted 只代表已接单，不代表完成。',
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
  requiresPermission: false,
};

export const steerTaskSchema: ToolSchema = {
  name: 'steer_task',
  description: '给一件正在执行或排队的后台任务补充信息、修正要求或改变方向，不新开任务。',
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
  requiresPermission: false,
};

export const cancelTaskSchema: ToolSchema = {
  name: 'cancel_task',
  description: '取消一件后台任务。目标不唯一时返回候选，随后必须用 AskUserQuestion 让用户按短名选择。',
  inputSchema: {
    type: 'object',
    properties: { target },
    required: [],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'execute',
  requiresPermission: false,
};

export const taskStatusSchema: ToolSchema = {
  name: 'task_status',
  description: '读取当前会话后台任务的真实状态。用户追问进度、完成情况或有哪些活在跑时必须先调用。',
  inputSchema: {
    type: 'object',
    properties: {},
    required: [],
    additionalProperties: false,
  },
  category: 'planning',
  permissionLevel: 'read',
  requiresPermission: false,
  readOnly: true,
};
