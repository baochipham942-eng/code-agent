// ============================================================================
// Plan Mode Rules - 规划模式指导（精简版）
// ============================================================================

import { applyOverride } from '../registry';

export const PLAN_MODE_RULES = applyOverride(
  { id: 'rules.planMode', category: '规则', name: 'Plan Mode 规则', description: 'plan 模式只输出方案不写代码的约束' },
  `
## Plan Mode（规划模式）

复杂任务（3+文件、架构变更、需求不明确）使用 \`PlanMode\`。

**流程**：
1. 必要时用 Task(explore) 做单点探索；多路并行探索用 AgentSpawn
2. Task(plan) 设计方案
3. 整合结果 + AskUserQuestion 澄清
4. 生成计划（文件清单、步骤、风险）
5. **必须** PlanMode({ action: "exit", plan }) 请求批准

**跳过规划**：单文件修改、需求明确、纯探索任务。

**⚠️ Plan Mode 是只读模式，禁止写入操作**
`,
);
