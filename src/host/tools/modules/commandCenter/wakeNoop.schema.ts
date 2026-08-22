import type { ToolSchema } from '../../../protocol/tools';

/** Hidden foreground wakes use this as an explicit, terminal "nothing to say" action. */
export const wakeNoopSchema: ToolSchema = {
  name: 'wake_noop',
  description: '仅用于后台任务结果触发的隐藏唤醒回合：没有值得告知用户的交付、结论或待决策事项时调用。调用后本轮立即结束，不输出文字。',
  outputSchema: { type: 'string' },
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
