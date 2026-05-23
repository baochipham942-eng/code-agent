// Schema-only file — /goal 自治循环的"申请退出"信号工具
import type { ToolSchema } from '../../../protocol/tools';

export const ATTEMPT_COMPLETION_DESCRIPTION = `在 /goal 自治模式下，当你确信目标已达成时调用本工具申请退出循环。

重要：调用本工具只是"申请退出"，不是判定完成。系统会在代码层运行预先约定的验证命令来核实——验证通过才真正结束；验证不通过会把失败原因返还给你、要求继续。所以：
- 不要在没有实际完成、缺乏可验证证据时调用；
- 也无法靠"声称已完成"绕过验证。

参数 summary：简述你做了什么、为什么认为目标已达成。`;

export const attemptCompletionSchema: ToolSchema = {
  name: 'attempt_completion',
  description: ATTEMPT_COMPLETION_DESCRIPTION,
  inputSchema: {
    type: 'object',
    properties: {
      summary: {
        type: 'string',
        description: '简述已完成的工作与达成目标的依据',
      },
    },
    required: ['summary'],
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: false,
};
