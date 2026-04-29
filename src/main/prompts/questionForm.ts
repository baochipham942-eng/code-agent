// ============================================================================
// Question Form Prompt - 设计 brief 收集指令
// ============================================================================
// 用户请求视觉/文档/邮件/PPT 类 artifact 且当前 session 还没有 DesignBrief 时，
// 先 emit 一个 question-form 让用户补齐 surface/direction，再做 artifact。
// 配合 src/artifacts/question-form.ts 与 brief 注入链路使用。
// ============================================================================

export const QUESTION_FORM_PROMPT = `
## 设计 brief 收集（先问后做）

当用户请求视觉/文档/邮件/PPT/演示/落地页等"成品向" artifact，且本会话还没有锁定的 design brief 时，**第一步必须先 emit 一个 question-form**，把 surface（用什么形态承载）和 direction（什么调性）问清楚，再去生成 artifact。已经锁定 brief 的会话不要重复问。

格式：

\`\`\`question-form
{
  "surface": "landing_page",
  "direction": "premium",
  "intent": "（可选）一句话目标",
  "audience": "（可选）目标读者",
  "constraints": ["（可选）品牌色锁死", "（可选）禁用英文标题"],
  "references": ["（可选）参考站点 URL"]
}
\`\`\`

字段约束（值必须严格匹配，否则会被拒）：

- \`surface\`（必填）: \`app_screen\` | \`landing_page\` | \`dashboard\` | \`component\` | \`document\` | \`presentation\` | \`other\`
- \`direction\`（必填）: \`utilitarian\` | \`premium\` | \`playful\` | \`editorial\` | \`technical\` | \`calm\`
- \`intent\` / \`audience\`: 字符串，留空就别给字段
- \`constraints\` / \`references\`: 字符串数组，留空就别给字段

行为约定：

- emit question-form 这一轮**不要**同时输出其它 artifact（不要把 chart / generative_ui / spreadsheet / document 跟 question-form 混在同一回复里）
- 用占位值是给用户参考用的，**用户会在表单 UI 里改**——所以你提的默认值要符合任务直觉，但不要假装用户已经选过
- 用户提交后，下一轮你会在 system context 里收到锁定的 design brief（surface / direction / 等）；从那一轮起按 brief 生成实际 artifact
- 如果用户在自然语言里已经给齐了 surface 和 direction（例如"做一个 premium 调性的 landing page"），可以跳过 question-form，直接以推断 brief 出 artifact

不要把 question-form 用于普通问答、确认、需求澄清等场景，它只服务于"成品向 artifact 的 brief 收集"。
`.trim();
