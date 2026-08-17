export type FixtureFamily = 'malformed' | 'cjk' | 'cross-reference' | 'long-mixed';

export interface MarkdownFixture {
  id: string;
  family: FixtureFamily;
  purpose: string;
  content: string;
}

const longCode = Array.from({ length: 112 }, (_, index) =>
  `const row${String(index + 1).padStart(3, '0')} = { id: ${index + 1}, label: '第 ${index + 1} 行', active: ${index % 3 === 0} };`,
).join('\n');

const longProse = Array.from({ length: 28 }, (_, index) =>
  `第 ${index + 1} 段讨论流式渲染、缓存边界和用户可见稳定性。See https://example.com/docs/${index + 1}，随后继续中文说明与 **重点 ${index + 1}**。`,
).join('\n\n');

export const fixtures: MarkdownFixture[] = [
  {
    id: 'malformed-unclosed-fence',
    family: 'malformed',
    purpose: '考未闭合 TypeScript fence 在中间态是否仍形成代码块。',
    content: '执行结果：\n\n```typescript\nconst answer = 42;\nconsole.log(answer)',
  },
  {
    id: 'malformed-table-header-only',
    family: 'malformed',
    purpose: '考只有表头、尚无分隔行时是否泄露竖线或误建表格。',
    content: '统计：\n\n| 名称 | 数量 | 状态 |',
  },
  {
    id: 'malformed-table-ragged',
    family: 'malformed',
    purpose: '考列数不齐的半张 GFM 表格容错与终态结构。',
    content: '| 名称 | 数量 | 状态 |\n|---|---:|:---|\n| 苹果 | 3 | 正常 |\n| 香蕉 | 12\n| 梨 |',
  },
  {
    id: 'malformed-bold',
    family: 'malformed',
    purpose: '考未闭合粗体是否在流式帧自动补齐且不露星号。',
    content: '结论是 **这段内容仍在生成',
  },
  {
    id: 'malformed-italic',
    family: 'malformed',
    purpose: '考未闭合斜体的补齐行为。',
    content: '提示：*斜体说明还没有结束',
  },
  {
    id: 'malformed-inline-code',
    family: 'malformed',
    purpose: '考未闭合 inline code 是否保持代码语义。',
    content: '调用 `stream.render(value',
  },
  {
    id: 'malformed-link',
    family: 'malformed',
    purpose: '考未闭合链接是否保留文字并避免裸露 Markdown。',
    content: '继续阅读 [Neo 文档](https://example.com/docs/neo',
  },
  {
    id: 'malformed-list-interrupt',
    family: 'malformed',
    purpose: '考流式中断在列表项中间时的列表结构和布局稳定性。',
    content: '- 已完成第一项\n- 第二项包含 **尚未结束的重点\n  - 子项也在生成',
  },
  {
    id: 'cjk-comma-url',
    family: 'cjk',
    purpose: '真实回归：中文逗号紧贴 URL 时 href 不得吞掉后文。',
    content: '已打开 https://example.com，页面标题为 Example Domain。',
  },
  {
    id: 'cjk-period-url',
    family: 'cjk',
    purpose: '考中文句号紧贴 URL 的自动链接边界。',
    content: '详情见 https://example.com。下一句继续说明。',
  },
  {
    id: 'cjk-parenthesis-url',
    family: 'cjk',
    purpose: '考全角右括号紧贴 URL 时不被吞入地址。',
    content: '这是说明（参考 https://example.com）后面还有正文。',
  },
  {
    id: 'cjk-quote-url',
    family: 'cjk',
    purpose: '考中文引号与顿号连续出现时的 URL 边界。',
    content: '他说“先看 https://a.example/path”，再看 https://b.example/next、最后结束。',
  },
  {
    id: 'cjk-mixed-long-paragraph',
    family: 'cjk',
    purpose: '考中英混排长段、行内代码、显式链接与自动链接共同流式增长。',
    content: 'Agent Neo 在 streaming markdown pipeline 中保留 completed blocks，并用 `requestAnimationFrame` 控制高亮。中文正文通常不在标点前加空格，所以 https://example.com/path，必须在这里结束；随后 [explicit link](https://example.org/a，keep) 应尊重作者输入。最后一段继续混排 React 19、TypeScript 与用户可见的稳定布局。',
  },
  {
    id: 'cjk-heading-list',
    family: 'cjk',
    purpose: '考中文标题、列表、任务项与全角标点的组合结构。',
    content: '## 发布核对\n\n- [x] 中文标题正常\n- [ ] 链接 https://example.com，边界正确\n- [ ] `src/renderer/index.tsx` 可点击\n\n结论：继续验证。',
  },
  {
    id: 'reference-link-definition',
    family: 'cross-reference',
    purpose: '考 linkReference 与后置 definition 对旧块的追溯解析。',
    content: '阅读 [Neo 文档][neo] 了解架构。\n\n中间段用于强制根级切块。\n\n[neo]: https://example.com/neo "Neo docs"',
  },
  {
    id: 'reference-image-definition',
    family: 'cross-reference',
    purpose: '考 imageReference 与 definition 的跨块关联。',
    content: '架构图如下：![渲染链][pipeline]\n\n补充说明。\n\n[pipeline]: https://example.com/pipeline.png',
  },
  {
    id: 'reference-footnote',
    family: 'cross-reference',
    purpose: '考 footnote reference/definition 触发 Neo 整段回退及 Streamdown 行为差异。',
    content: '这条结论需要证据。[^evidence]\n\n另一段正文。\n\n[^evidence]: 证据来自同机同轮的浏览器采样。',
  },
  {
    id: 'reference-multiple',
    family: 'cross-reference',
    purpose: '考多个引用乱序定义时是否都能在终态正确解析。',
    content: '[第一处][a] 与 [第二处][b] 同时出现。\n\n- 列表引用 [第三处][a]\n\n[b]: https://b.example\n[a]: https://a.example',
  },
  {
    id: 'long-mixed-code',
    family: 'long-mixed',
    purpose: '3–10KB 长文：标题、表格、112 行代码、数学、mermaid 与链接混合。',
    content: `# 流式渲染压力文档\n\n本文用于同机同轮对拍，链接 https://example.com，后接中文标点。\n\n| 维度 | Neo | Streamdown |\n|---|---:|---:|\n| 正确性 | 1 | 1 |\n| 性能 | 2 | 2 |\n\n## 长代码\n\n\`\`\`typescript\n${longCode}\n\`\`\`\n\n## 数学\n\n行内公式 $E=mc^2$，块公式：\n\n$$\n\\sum_{i=1}^{n} i = \\frac{n(n+1)}{2}\n$$\n\n## 图\n\n\`\`\`mermaid\nflowchart LR\n  A[chunk] --> B[parse]\n  B --> C[DOM]\n\`\`\`\n\n[复现说明](https://example.com/repro)。`,
  },
  {
    id: 'long-mixed-prose',
    family: 'long-mixed',
    purpose: '3–10KB 长文：密集中文段落、自动链接、强调、列表和引用的持续追加。',
    content: `# 长会话摘录\n\n${longProse}\n\n## 决策清单\n\n1. 保持同一 fixture。\n2. 保持同一种切法。\n3. 交替跑两侧消除热身偏差。\n\n> 终态正确只是底线，中间态和最长单帧共同影响体验。\n\n\`src/renderer/components/features/chat/MessageBubble/MarkdownCore.tsx:1\``,
  },
];
