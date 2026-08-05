import type { ToolSchema } from '../../../protocol/tools';

const target = {
  type: 'string',
  description: '任务 id、task_status 返回的序号、2-4 字短名或唯一标题片段。省略时只在当前恰好一件活跃任务时生效。',
} as const;

export const spawnTaskSchema: ToolSchema = {
  name: 'spawn_task',
  description: '把一件需要读写文件、运行命令、联网、多步执行或等待审批的工作交给独立后台任务。accepted 只代表已接单，不代表完成。',
  inputSchema: {
    type: 'object',
    properties: {
      title: { type: 'string', description: '用户可读的一句话任务标题。' },
      short_name: { type: 'string', description: '2-4 个汉字的任务短名，用于状态、转向和取消。' },
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
