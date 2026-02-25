---
name: ppt-generate
description: 生成高质量演示文稿，包含风格决策、内容规划和结构化输出
license: MIT
compatibility: code-agent >= 0.16
metadata:
  category: content-generation
  keywords: ppt, presentation, slides, powerpoint
---

## 概述

本 Skill 增强 PPT 生成质量。在调用 `ppt_generate` 工具前，先完成三步决策：风格选择、页面规划、内容预结构化。

## 第一步：风格决策

根据用户意图选择 theme 和 mode 组合：

| 场景 | 推荐 theme | 推荐 mode | 视觉语言 |
|------|-----------|-----------|---------|
| 商业汇报/融资路演 | `corporate` | `generate` | 专业克制，蓝白配色，数据驱动，清晰的层次结构 |
| 技术分享/开发者大会 | `neon-green` 或 `apple-dark` | `design` | 深色背景，霓虹强调色，代码风格排版，科技感十足 |
| 产品发布/创意展示 | `glass-dark` 或 `glass-light` | `design` | 磨砂玻璃质感，渐变色彩，Bento 网格布局，苹果 Keynote 风格 |
| 学术报告/教学课件 | `minimal-mono` | `generate` | 极简黑白，大量留白，Typography 驱动，内容为王 |
| 市场营销/品牌宣传 | `neon-purple` 或 `neon-orange` | `design` | 大胆配色，视觉冲击力，大字标题，情感化表达 |
| 内部周报/工作总结 | `corporate` 或 `glass-light` | `generate` | 简洁高效，重点突出，快速产出 |

**风格描述注入**：将视觉语言描述融入 content 参数开头，格式：
```
[风格指导] 深色背景科技风格，霓虹绿强调色，Bento 网格布局，数据可视化优先
---
（正式内容从这里开始）
```

## 第二步：页面规划

根据用户要求的页数，按以下模板规划 page_type 序列：

### 5 页（极简汇报）
```
1. [封面] → layout: title
2. [背景] 行业现状/问题陈述 → layout: list 或 comparison
3. [方案] 核心解决方案 → layout: cards-3 或 timeline
4. [数据] 关键成果/指标 → layout: stats 或 chart
5. [总结] 行动号召 → layout: quote（END master）
```

### 10 页（标准汇报）
```
1. [封面] → layout: title
2. [背景] 行业现状 → layout: list
3. [问题] 核心矛盾/痛点 → layout: comparison
4-7. [方案×4] 解决方案展开 → layout: cards-3 / timeline / list / cards-3（交替使用）
8. [数据] 量化成果 → layout: stats 或 chart
9. [计划] 下一步行动 → layout: timeline
10. [总结] 感谢+CTA → layout: quote（END master）
```

### 15 页（深度汇报）
```
1. [封面] → layout: title
2. [执行摘要] 核心结论前置 → layout: stats
3. [背景] 行业现状 → layout: list
4. [问题] 核心矛盾 → layout: comparison
--- 第一章 ---
5. [章节引导] 章节标题 → layout: quote
6-7. [方案×2] → layout: cards-3 / timeline
8. [数据] 本章数据佐证 → layout: chart
--- 第二章 ---
9. [章节引导] → layout: quote
10-11. [方案×2] → layout: list / cards-3
12. [数据] → layout: stats
--- 收尾 ---
13. [案例] 成功案例 → layout: cards-3
14. [计划] 路线图 → layout: timeline
15. [总结] → layout: quote（END master）
```

### 20+ 页（全面报告）
```
在 15 页基础上扩展：
- 增加第三章节（3 页）
- 每章节增加 1 页案例/对比
- 可增加附录页（数据来源、参考文献）
```

## 第三步：内容预结构化

将用户的原始内容按上述 page_type 序列重新组织。每页标注类型和推荐 layout：

```markdown
## [封面] {layout: title}
标题：（从用户意图提炼，10字以内，行动导向）
副标题：（场景/日期/受众）

## [背景] {layout: list}
- 第一个背景要点（带具体数据）
- 第二个背景要点
- 第三个背景要点

## [数据] {layout: stats}
- 指标1名称：数值（同比变化）
- 指标2名称：数值
- 指标3名称：数值

## [方案] {layout: cards-3}
三个核心策略：
1. 策略名称 — 一句话描述
2. 策略名称 — 一句话描述
3. 策略名称 — 一句话描述
```

**标题规则**（SCQA Action Title）：
- "Agent 市场 $680 亿，但 90% 仍在试点" — 结论型标题
- ~~"市场分析"~~ — 主题型标题（禁止）

**数据规则**：
- 优先使用 research 阶段获取的真实数据
- 如果 `ppt_generate` 的 `research: true`（默认），不需要在 content 中编造数据
- 在 content 中标注 `[需要数据]` 占位符，让 research 阶段填充

## 调用示例

```
分析用户需求后，按以下方式调用：

ppt_generate({
  topic: "AI 时代的产品设计",
  content: "[风格指导] 深色科技风，霓虹绿强调色，数据可视化优先\n---\n## [封面] {layout: title}\n标题：AI 重塑产品设计的三个转折点\n副标题：2025 产品设计峰会\n\n## [背景] {layout: stats}\n- 全球 AI 市场规模：$1840亿（2025）\n- AI 辅助设计工具渗透率：32%\n- 设计效率提升：平均 47%\n\n## [问题] {layout: comparison}\n左：传统设计流程\n- 用户调研 2-4 周\n- 原型迭代 3-5 轮\n- 上线周期 3-6 个月\n右：AI 驱动设计\n- 实时用户行为分析\n- AI 原型生成 + 人工精调\n- 快速验证 2-4 周\n\n...(后续页面)",
  slides_count: 10,
  theme: "neon-green",
  mode: "design",
  research: true,
  images: true
})
```

## 注意事项

1. **mode 选择**：`design` 模式视觉质量更高但耗时更长（LLM 直接生成 pptxgenjs 代码）；`generate` 模式更快更稳定（结构化 JSON → 模板渲染）。日常用 generate，重要场合用 design
2. **images 参数**：设为 true 时会自动为适合的页面生成 AI 配图（CogView），额外耗时约 10 秒
3. **research 参数**：默认 true，会做 3 次 web_search 获取最新数据。如果用户已提供完整数据，可设为 false 节省时间
4. **layout 不是强制的**：`{layout: xxx}` 是建议，`ppt_generate` 内部会根据实际内容做最终选择
5. **别贪多**：每页最多 5 个要点，每个要点不超过 20 个中文字。宁可多分页，不要堆砌
