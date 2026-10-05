// Schema-only file（P0-7 方案 A — single source of truth）
// decide — 批量判定：一趟 Jev（TypeSafe System One）调用判完多条
// yes/no、单选或打分，成本远低于主模型逐条判。
// 仅在 resolveJevRoute() 找到可用路由时才进工具表（isDecideToolAvailable），
// 无路由时既不列出也不可搜（注册仍在 protocol registry，deferred 元数据仍登记）。
import type { ToolSchema } from '../../../protocol/tools';

export const decideSchema: ToolSchema = {
  name: 'decide',
  description: `批量判定：把一批同判据的是非题、单选题或打分题打包成一次廉价 Jev 调用，一趟判完。

适用：按同一套判据处理成堆的条目（工单分流、简历初筛、反馈归类、内容审核）。
不适用：需要推理链或生成内容的任务（那是主模型的活）。

**输入结构：**
- \`state\`：共享判据与材料（≤20000 字符）——判据写清楚，所有条目共用。
- \`items\`：1-32 条，每条 \`{ id, kind, question, options? }\`：
  - \`kind: "yes_no"\`：是非题，无需 options。
  - \`kind: "choice"\`：单选题，options 给 2-8 个选项文本。
  - \`kind: "score"\`：打分题，options 给 2-6 档有序档位文本（低→高）。
- \`sure_min\`：置信门槛 0-1，默认 0.7。

**输出：** 每条结果带 \`sure\`（0-1 置信度）；低于 \`sure_min\` 或判定被拒收的条目单独列进 \`needs_human\`，这些不要自动放行，交给人工。每条成本按题数计入当日费用。

**示例：**
\`\`\`
decide {
  "state": "判据：客服工单是否属于账单争议……",
  "items": [
    { "id": "T01", "kind": "yes_no", "question": "工单 T01 属于账单争议吗？" },
    { "id": "T02", "kind": "choice", "question": "工单 T02 该转给哪个组？", "options": ["账务组", "技术组", "通用组"] }
  ]
}
\`\`\``,
  outputSchema: { type: 'string' },
  inputSchema: {
    type: 'object',
    properties: {
      state: {
        type: 'string',
        description: '共享判据与材料，最多 20000 字符。所有条目共用，先写判据再批量判。',
      },
      items: {
        type: 'array',
        description: '待判条目，1-32 条；id 需唯一且 ≤40 字符（超限直接报错，不会发起调用）。',
        items: {
          type: 'object',
          properties: {
            id: { type: 'string', description: '条目 id（≤40 字符，批内唯一），结果按它对账。' },
            kind: {
              type: 'string',
              enum: ['yes_no', 'choice', 'score'],
              description: '题型：yes_no 是非 / choice 单选 / score 打分。',
            },
            question: { type: 'string', description: '该条目的问题文本。' },
            options: {
              type: 'array',
              items: { type: 'string' },
              description: 'choice 给 2-8 个选项文本；score 给 2-6 档有序档位文本（低→高）；yes_no 不需要。',
            },
          },
          required: ['id', 'kind', 'question'],
        },
      },
      sure_min: {
        type: 'number',
        minimum: 0,
        default: 0.7,
        description: '置信门槛（0-1，默认 0.7）。低于它的条目进 needs_human。',
      },
    },
    required: ['state', 'items'],
  },
  category: 'network',
  permissionLevel: 'network',
  readOnly: true,
  allowInPlanMode: true,
};
