// ============================================================================
// Design Mode — LLM Prompt 构建
// ============================================================================
// 主 Prompt：角色 + DS 引用 + API 精简 + SCQA + 研究数据
// 修订 Prompt：原始代码 + VLM 发现的问题
// ============================================================================

import type { ThemeConfig, ResearchContext } from './types';
import { generateGoldenAnglePalette } from './colorUtils';
import { RESEARCH_SLICE, DESIGN_CANVAS } from './constants';

/**
 * 格式化研究数据注入 prompt
 */
function formatResearch(research: ResearchContext): string {
  const parts: string[] = [];

  if (research.statistics.length > 0) {
    parts.push('## 已验证的统计数据（必须引用，不可虚构）');
    for (const s of research.statistics.slice(0, RESEARCH_SLICE.STATISTICS)) {
      parts.push(`- ${s.label}: ${s.value}${s.description ? ` (${s.description})` : ''} [${s.source}]`);
    }
  }

  if (research.facts.length > 0) {
    parts.push('\n## 关键事实');
    for (const f of research.facts.slice(0, RESEARCH_SLICE.FACTS)) {
      parts.push(`- ${f.content} [${f.source}]`);
    }
  }

  if (research.quotes.length > 0) {
    parts.push('\n## 可用引言');
    for (const q of research.quotes.slice(0, RESEARCH_SLICE.QUOTES)) {
      parts.push(`- "${q.text}" — ${q.attribution}`);
    }
  }

  return parts.join('\n');
}

/**
 * 构建设计模式主 Prompt
 */
export function buildDesignPrompt(
  topic: string,
  slideCount: number,
  theme: ThemeConfig,
  research?: ResearchContext,
): string {
  const palette = generateGoldenAnglePalette(theme.accent, 4);
  const fontTitle = theme.fontTitleCN || theme.fontTitle;
  const fontBody = theme.fontBodyCN || theme.fontBody;

  const now = new Date();
  const dateStr = `${now.getFullYear()}年${now.getMonth() + 1}月`;

  const researchSection = research
    ? `\n---\n${formatResearch(research)}\n---\n⚠️ 所有数据必须来自上述已验证数据，禁止虚构数字。\n`
    : '\n⚠️ 无已验证数据。使用定性描述（如"显著增长"、"行业领先"），禁止编造具体数字/百分比/金额。\n';

  return `你是高级演示文稿设计师，直接编写 pptxgenjs 代码来构建幻灯片。

## 主题：${topic}
## 页数：${slideCount}
## 日期：${dateStr}
${researchSection}
## 设计系统（已预定义，直接使用变量名）

颜色：
- DS.bg='${theme.bgColor}' DS.bgCard='${theme.bgSecondary}' DS.text='${theme.textPrimary}'
- DS.textMuted='${theme.textSecondary}' DS.accent='${theme.accent}' DS.glow='${theme.accentGlow}'
- DS.accent2='${palette[1]}' DS.accent3='${palette[2]}' DS.accent4='${palette[3]}'
- DS.border='${theme.cardBorder}' DS.isDark=${theme.isDark}

字体：F.title='${fontTitle}' F.body='${fontBody}' F.code='${theme.fontCode}'

画布：W=${DESIGN_CANVAS.WIDTH}" H=${DESIGN_CANVAS.HEIGHT}" MX=${DESIGN_CANVAS.MARGIN_X}(左右边距) CW=${+(DESIGN_CANVAS.WIDTH - DESIGN_CANVAS.MARGIN_X * 2).toFixed(2)}(内容宽) 内容区 y: 1.3~${DESIGN_CANVAS.HEIGHT - DESIGN_CANVAS.MARGIN_Y * 2}

## Helper 函数（已预定义，直接调用）

基础：
- addBg(slide, color?) — 设置背景色，默认 DS.bg
- addTitle(slide, text, opts?) — 页标题，y=0.4, fontSize=28
- addFooter(slide, text) — 底部居中小字
- addPageNum(slide, num, total) — 右下角页码
- addCard(slide, x, y, w, h, opts?) — 圆角矩形卡片，opts: {fill, line:{color,width}, radius}
- dimColor(hex, opacity?) — 混合颜色与背景，模拟半透明（默认 opacity=0.2）
- hex6(color) — 清洗颜色值到 6 位 hex（自动去 # 和多余字符）

高级布局（自动计算坐标，不需要手动计算位置）：
- addHubSpoke(slide, centerLabel, nodes, opts?) — 中心辐射图，nodes=[{label, desc?, color?}]，自动左右分布+水平连线
- addTimeline(slide, milestones, opts?) — 水平时间轴，milestones=[{year, label, desc?, color?}]，标签在上、描述在下、绝不重叠

## pptxgenjs API（仅用这些）

- const s = pptx.addSlide() — 新建幻灯片
- s.addText(text, {x,y,w,h, fontSize, fontFace, color, bold, align, valign, lineSpacingMultiple}) — 文字
- s.addShape('rect'|'roundRect'|'ellipse'|'line', {x,y,w,h, fill:{color}, line:{color,width}, rectRadius}) — 形状
- s.addChart(pptx.charts.BAR|LINE|DOUGHNUT, [{name,labels,values}], {x,y,w,h, ...}) — 图表
- s.addImage({path|data, x,y,w,h}) — 图片
- s.addNotes(text) — Speaker Notes

颜色值用 6 位 hex 无 #。坐标单位英寸。
❌ DS.accent + '20'（会变成 8 位 hex，pptxgenjs 报错）
✅ dimColor(DS.accent, 0.2)（正确的半透明效果）

## 布局模式库（每页选一种，整套不重复）

| 模式 | 适用场景 | 要点 |
|------|----------|------|
| **Bento Grid** | 指标看板 | 3-4 个等宽卡片排一行，每卡：大数字+标签+趋势 |
| **Hub-Spoke** | 架构/关系 | 中心圆+4-6个外围矩形，线条连接 |
| **分层堆叠** | 技术栈/流程 | 3-4 层水平条带，从上到下渐宽/渐窄 |
| **左右对比** | 对比/优劣 | 左右各一个大卡片，标题颜色区分 accent vs accent2 |
| **时间轴** | 演进/里程碑 | 水平线+3-5节点圆点+上下交替标签 |
| **数据+图表** | 数据驱动 | 左侧 addChart()，右侧 3 个要点卡片 |
| **编号步骤** | 方法论/流程 | 3 列卡片，顶部大编号圆，标题+描述 |
| **Hero 引言** | 金句/观点 | 居中大引号，下方署名，装饰性 accent 线 |

⚠️ 整套 PPT 至少使用 5 种不同布局。相邻两页不要用相同模式。
⚠️ 紧凑排版：卡片高度紧贴内容（4 个要点 ≈ 3.5 英寸高），标题和正文间距 ≤ 0.3 英寸，禁止大面积留白。

## Few-shot 示例（高质量参考）

### 示例 A: Bento Grid 指标看板
\`\`\`typescript
// --- Slide 2: 市场规模 ---
{
  const s = pptx.addSlide();
  addBg(s);
  addTitle(s, '全球 AI Agent 市场突破 $680 亿，企业采用率翻倍');

  const metrics = [
    { label: '市场规模', value: '$680亿', sub: 'YoY +147%', color: DS.accent },
    { label: '企业采用率', value: '34%', sub: '较去年翻倍', color: DS.accent2 },
    { label: '月活开发者', value: '280万', sub: '+89% YoY', color: DS.accent3 },
  ];

  const cardW = (CW - 0.4) / 3;
  metrics.forEach((m, i) => {
    const x = MX + i * (cardW + 0.2);
    addCard(s, x, 1.5, cardW, 3.8);
    // 色带
    s.addShape('rect' as any, { x, y: 1.5, w: cardW, h: 0.12, fill: { color: m.color } });
    // 大数字
    s.addText(m.value, {
      x: x + 0.3, y: 2.2, w: cardW - 0.6, h: 1.0,
      fontSize: 40, fontFace: F.title, color: m.color, bold: true, align: 'center',
    });
    // 标签
    s.addText(m.label, {
      x: x + 0.3, y: 3.3, w: cardW - 0.6, h: 0.4,
      fontSize: 14, fontFace: F.body, color: DS.text, align: 'center',
    });
    // 趋势
    s.addText(m.sub, {
      x: x + 0.3, y: 3.8, w: cardW - 0.6, h: 0.4,
      fontSize: 12, fontFace: F.body, color: DS.textMuted, align: 'center',
    });
  });

  addPageNum(s, 2, 10);
  s.addNotes('全球 AI Agent 市场规模 $680 亿...');
}
\`\`\`

### 示例 B: Hub-Spoke 架构图（使用 addHubSpoke helper）
\`\`\`typescript
// --- Slide 6: MCP 协议 ---
{
  const s = pptx.addSlide();
  addBg(s);
  addTitle(s, 'MCP 协议统一工具接口，Function Calling 延迟降至 200ms 内');
  addHubSpoke(s, 'MCP\\n协议层', [
    { label: 'API 网关', desc: '标准化调用', color: DS.accent2 },
    { label: '搜索引擎', desc: '语义检索', color: DS.accent3 },
    { label: '数据库', desc: '结构化存储', color: DS.accent3 },
    { label: '代码执行', desc: '沙箱运行', color: DS.accent4 },
  ]);
  addFooter(s, '标准化接口协议  |  动态能力发现  |  安全沙箱执行');
  addPageNum(s, 6, 10);
  s.addNotes('MCP 协议的核心价值...');
}
\`\`\`

### 示例 C: 时间轴（使用 addTimeline helper）
\`\`\`typescript
// --- Slide 7: 技术演进 ---
{
  const s = pptx.addSlide();
  addBg(s);
  addTitle(s, '技术演进呈现阶段性突破，多模态与自主规划成为下一里程碑');
  addTimeline(s, [
    { year: '2023', label: '大模型爆发', desc: 'GPT-4 引爆 Agent 浪潮', color: DS.accent },
    { year: '2024', label: '工具标准化', desc: 'MCP + Function Calling', color: DS.accent2 },
    { year: '2025', label: '多 Agent 协作', desc: '编排框架成熟', color: DS.accent3 },
    { year: '2026', label: '自主决策', desc: '端到端自动执行', color: DS.accent4 },
  ]);
  addPageNum(s, 7, 10);
  s.addNotes('技术演进的四个阶段...');
}
\`\`\`

⚠️ 以上仅为参考。Hub-Spoke 和 Timeline 场景**必须**使用上面的 helper 函数，不要手动计算坐标。其他布局自由发挥。

## 叙事规范

### SCQA 框架
- 第 1 页：封面（大标题 + 副标题/日期）
- 第 2 页：S（Situation）背景 — 建立事实共识
- 第 3 页：C（Complication）矛盾 — 揭示核心问题
- 第 4~${Math.max(slideCount - 2, 5)} 页：A（Answer）方案 — 金字塔展开，占 ~70% 页数
- 最后 1 页：结尾 — 行动号召 / Thank You

### Action Title 铁律
标题是结论，不是标签：
❌ "市场分析"  "技术架构"
✅ "全球 AI Agent 市场 $680 亿，90% 仍在试点"  "三层架构将延迟降低 60%"

### 7×7 排版规则
- 每页最多 5 个要点，每个要点最多 20 字
- 标题 ≤ 15 个中文字（一行放下）
- 留白 > 内容
- Speaker Notes 放详细数据和论证

## 输出要求

只输出 slide 代码段（不含 import/export/main）。
每页前加注释 \`// --- Slide N: 用途 ---\`

示例结构：
\`\`\`typescript
// --- Slide 1: 封面 ---
{
  const s = pptx.addSlide();
  addBg(s);
  s.addText('标题', { x: MX, y: 2.5, w: CW, h: 1.2, fontSize: 44, fontFace: F.title, color: DS.accent, bold: true, align: 'center' });
  s.addText('副标题', { x: MX, y: 3.8, w: CW, h: 0.6, fontSize: 18, fontFace: F.body, color: DS.textMuted, align: 'center' });
  s.addNotes('这是封面，介绍...');
}

// --- Slide 2: 背景 ---
{
  const s = pptx.addSlide();
  addBg(s);
  addTitle(s, '行业现状与机遇');
  // ... 自由布局
  addPageNum(s, 2, ${slideCount});
  s.addNotes('详细背景说明...');
}
\`\`\`

每页用 {} 块包裹变量作用域。每页必须有 addBg() 和 s.addNotes()。

## 设计品味检查清单

- 装饰元素（形状/圆环/渐变色块）提升视觉丰富度，但不要遮挡内容
- 颜色对比度：文字与背景 contrast ratio ≥ 4.5:1
- 卡片内文字左右预留 ≥ 0.3" padding
- 大数字（fontSize ≥ 36）配小标签（fontSize 12-14）形成视觉层次
- 同一行元素底部对齐（y + h 一致）
- 每页 y 坐标不超过 6.5（底部留给页码）

请为"${topic}"生成 ${slideCount} 页完整的 slide 代码。`;
}

/**
 * 构建修订 Prompt（VLM 审查后）
 */
export function buildRevisionPrompt(originalCode: string, vlmIssues: string): string {
  return `你之前生成了以下 slide 代码，VLM 视觉审查发现了一些问题。请精确修复。

## 原始代码
\`\`\`typescript
${originalCode}
\`\`\`

## VLM 审查发现的问题（含修复建议）
${vlmIssues}

## 修复策略（8 维度对应修复方法）

| 维度 | 修复方法 |
|------|----------|
| text_readability | 文字截断→缩短文字或减小 fontSize（每次降 2pt）；低对比度→深背景用浅色文字（FFFFFF/E0E0E0），浅背景用深色文字；字号层级不清→标题 ≥ 28pt，正文 ≥ 16pt |
| layout_precision | 重叠→调整 y 坐标增加间距（≥0.2"）或缩小元素；错位→同行元素统一 y 坐标，卡片间距统一 |
| information_density | 过密→删减次要内容到 Notes，减少到 ≤ 5 个信息点；过空→增大元素或添加装饰形状 |
| visual_hierarchy | 关键数字 fontSize ≥ 36，标签 fontSize 12-14，形成 2x 以上大小对比；确保标题最突出 |
| color_contrast | 配色不协调→统一到 ≤ 4 主色；对比度不足→调整文字/背景颜色差异 |
| consistency | 统一字体族（≤ 2 个），统一标题/正文位置和间距，统一配色方案 |
| composition | 调整元素分布使视觉重心居中偏上；避免单侧堆积，利用网格均衡布局 |
| professional_polish | 统一圆角/阴影/间距细节；替换低质量图片；增加设计感装饰（分割线/色块） |

## 要求
1. 只修改有问题的 slide，保持其他 slide 不变
2. 返回完整的 slide 代码（所有页面，包含未修改的）
3. 保持原有注释格式 \`// --- Slide N: 用途 ---\`
4. 对每个 VLM issue 的 fix 建议逐一落实到代码中`;
}

/**
 * 构建错误修复 Prompt（执行失败后）
 */
export function buildErrorFixPrompt(originalCode: string, errorMessage: string): string {
  return `你之前生成的 slide 代码执行失败。请修复错误。

## 原始代码
\`\`\`typescript
${originalCode}
\`\`\`

## 错误信息
\`\`\`
${errorMessage}
\`\`\`

## 要求
1. 修复导致错误的代码
2. 返回完整的 slide 代码（所有页面）
3. 常见错误：拼写错误、未定义变量、API 参数格式不对
4. 确保所有颜色值是 6 位 hex（无 #），坐标是数字`;
}
