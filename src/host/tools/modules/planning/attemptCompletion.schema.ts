// Schema-only file — /goal 自治循环的"申请退出"信号工具
import type { ToolSchema } from '../../../protocol/tools';

export const ATTEMPT_COMPLETION_DESCRIPTION = `在 /goal 自治模式下，当你确信目标已达成时调用本工具申请退出循环。

重要：调用本工具只是"申请退出"，不是判定完成。系统会在代码层核实——先核验你提交的公开证据（闸0），再运行预先约定的验证命令（闸1/闸2）——全部通过才真正结束；不通过会把失败原因返还给你、要求继续。所以：
- 不要在没有实际完成、缺乏可验证证据时调用；
- 也无法靠"声称已完成"绕过验证。

参数：
- summary：简述你做了什么、为什么认为目标已达成。
- evidence.deliverables：本次目标的最终产物文件路径清单（系统会逐个核验文件真实存在）。
- evidence.commands：支撑完成结论的关键命令（系统会核验这些命令真的在本次会话里执行过）。
只声称不举证 = 证据不足，会被打回。`;

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
      evidence: {
        type: 'object',
        description: '公开证据：系统程序化核验，核验不过无法退出',
        properties: {
          deliverables: {
            type: 'array',
            items: { type: 'string' },
            description: '最终产物文件路径清单（相对工作目录或绝对路径）',
          },
          commands: {
            type: 'array',
            items: { type: 'string' },
            description: '支撑结论的关键命令（须与本会话内实际执行过的命令匹配）',
          },
        },
      },
    },
    required: ['summary'],
  },
  category: 'planning',
  permissionLevel: 'read',
  readOnly: true,
  allowInPlanMode: false,
};
