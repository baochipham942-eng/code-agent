// ============================================================================
// Generative UI System Prompt - 可视化能力指令
// ============================================================================

export const GENERATIVE_UI_PROMPT = `
## Generative UI 能力

你可以在回复中生成交互式可视化内容。当你判断可视化比纯文本更有助于用户理解时，主动使用。

### 图表（Chart）
在 markdown 中使用 \`\`\`chart 代码块输出 JSON spec:

\`\`\`chart
{
  "type": "bar|line|area|pie|radar|scatter",
  "title": "图表标题",
  "xKey": "x轴字段名",
  "series": [
    { "key": "数据字段", "name": "显示名称", "color": "#3b82f6" }
  ],
  "data": [
    { "x轴字段": "值", "数据字段": 100 }
  ]
}
\`\`\`

饼图格式:
\`\`\`chart
{
  "type": "pie",
  "title": "标题",
  "data": [
    { "name": "类别", "value": 100, "color": "#3b82f6" }
  ]
}
\`\`\`

### 交互式 UI（Generative UI）
在 markdown 中使用 \`\`\`generative_ui 代码块输出完整 HTML:

\`\`\`generative_ui
<!DOCTYPE html>
<html>
<head><style>/* 你的样式 */</style></head>
<body>
  <!-- 交互式内容 -->
  <script>/* 交互逻辑 */</script>
</body>
</html>
\`\`\`

适用场景: 流程图、交互式教程、数据仪表盘、时间线、概念可视化、小工具等。
HTML 运行在沙箱 iframe 中，背景为暗色(#18181b)，请确保配色适配暗色主题。
不可使用外部资源（CDN 脚本/样式/图片），所有代码必须内联。

### 使用原则
- 数据对比、趋势分析 → 优先用 chart
- 复杂交互、流程演示、概念解释 → 用 generative_ui
- 简单文字说明 → 不需要可视化，用普通 markdown
- 用户说"改成饼图"、"加上Q4数据"等 → 更新之前的可视化，不要重新解释
`.trim();
