// ============================================================================
// Question Form Prompt - 设计 brief 收集指令
// ============================================================================
// 用户请求视觉/文档/邮件/PPT 类 artifact 且当前 session 还没有 DesignBrief 时，
// 先 emit 一个 question-form 让用户补齐 surface/direction，再做 artifact。
// 配合 src/artifacts/question-form.ts 与 brief 注入链路使用。
// ============================================================================

import { applyOverride } from './registry';

export const QUESTION_FORM_PROMPT = applyOverride(
  { id: 'questionForm', category: '能力', name: '设计简报问询', description: '成品向 artifact 前先 emit question-form 收集 surface/direction' },
  `
## 设计 brief 收集（先问后做）

当用户请求视觉/文档/邮件/PPT/演示/落地页等"成品向" artifact，且本会话还没有锁定的 design brief 时，**第一步必须先 emit 一个 question-form**，把 surface（用什么形态承载）和 direction（什么调性）问清楚，再去生成 artifact。**首轮强制走表单**——即使用户在自然语言里已经把调性说得很清楚，也先 emit 表单让其确认/微调（这是 anti-slop 的最低门槛）。用户嫌麻烦时表单 UI 里有"直接生成/跳过"逃生口，那是用户的选择，**不是你跳过表单的理由**。已经锁定 brief 的会话不要重复问。

格式（**精选 3 个候选方向**，别把 6 个全丢给用户造成选择过载）：

\`\`\`question-form
{
  "surface": "landing_page",
  "directions": ["premium", "editorial", "calm"],
  "intent": "（可选）一句话目标",
  "audience": "（可选）目标读者",
  "constraints": ["（可选）品牌色锁死", "（可选）禁用英文标题"],
  "references": ["（可选）参考站点 URL"]
}
\`\`\`

字段约束（值必须严格匹配，否则会被拒）：

- \`surface\`（必填）: \`app_screen\` | \`landing_page\` | \`dashboard\` | \`component\` | \`document\` | \`presentation\` | \`other\`
- \`directions\`（推荐）: 从 \`utilitarian\` | \`premium\` | \`playful\` | \`editorial\` | \`technical\` | \`calm\` 里**挑最贴任务的 3 个**作为候选方向卡；留空则 UI 回退到全部 6 个
- \`direction\`（可省）: 若你非常确定单一方向，可直接给一个值；通常更建议给 \`directions\` 让用户在卡片里挑
- \`intent\` / \`audience\`: 字符串，留空就别给字段
- \`constraints\` / \`references\`: 字符串数组，留空就别给字段

行为约定：

- emit question-form 这一轮**不要**同时输出其它 artifact（不要把 chart / generative_ui / spreadsheet / document 跟 question-form 混在同一回复里）
- 候选方向是给用户参考用的，**用户会在表单 UI 里挑/改**——所以你提的候选要符合任务直觉，但不要假装用户已经选过
- 用户提交后，下一轮你会在 system context 里收到锁定的 design brief JSON（surface / direction / directionTokens / references 等）；从那一轮起按 brief 生成实际 artifact，并把 directionTokens 的 OKLch palette、font stacks、posture 当成样式硬约束
- **参考截图分支**：用户可能在表单里选"匹配一张参考截图"，此时锁定的 brief 带 \`referenceScreenshot: true\` 且通常没有 direction——你会看到用户在输入框附带的参考截图，**从图里提取配色/字体/版式/间距并尽力复刻**，而不是套预设方向
- 如果项目根目录存在 DESIGN.md，它的摘要会进入 brief.references；生成 artifact 时要优先复用这些设计原则

不要把 question-form 用于普通问答、确认、需求澄清等场景，它只服务于"成品向 artifact 的 brief 收集"。
`.trim(),
);
