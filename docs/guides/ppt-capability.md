# PPT 生成系统能力文档

> 版本：v0.16.18+ | 最后更新：2026-02-06 | PR #51

## 概述

PPT 生成系统基于 pptxgenjs 4.0.1，采用 **Slide Master + Placeholder 声明式架构**，支持 9 种主题、6 种布局、3 种原生图表，以及 Legacy 降级路径。

## 架构

### 模块拆分

从单文件 `pptGenerate.ts`（1841 行）重构为 9 个职责清晰的模块：

```
src/main/tools/network/
├── ppt/                        # PPT 生成系统
│   ├── index.ts       (242行)  工具定义 + execute 入口
│   ├── types.ts        (85行)  共享类型定义
│   ├── themes.ts      (149行)  9 种主题配置
│   ├── slideMasters.ts(510行)  6 个 Slide Master 声明
│   ├── layouts.ts     (491行)  布局选择 + 内容填充
│   ├── charts.ts      (215行)  原生图表检测与渲染
│   ├── parser.ts      (163行)  Markdown 解析
│   ├── mermaid.ts      (77行)  Mermaid 处理
│   ├── legacy.ts     (1077行)  旧渲染函数（降级路径）
│   └── __tests__/
│       ├── ppt.test.mjs        55 个基础用例
│       └── ppt-extended.test.mjs 82 个扩展用例
├── mermaidToNative.ts          Mermaid → 原生图形转换
├── mermaidExport.ts            Mermaid → PNG 导出
└── outlineGenerator.ts         SCQA 大纲生成器
```

### 核心设计理念

借鉴 **Claude in PowerPoint** 的 3 个核心理念：

1. **Slide Master 声明式设计** — 用 `defineSlideMaster()` 定义装饰和骨架，内容通过 placeholder 填充，新增布局只需 ~15 行 master 定义
2. **原生可编辑图表** — 用 `addChart()` API 生成 PowerPoint 原生图表，用户可双击编辑数据
3. **内容驱动的布局选择** — 根据标题关键词和要点特征自动选择最佳布局

## 工具参数

```typescript
ppt_generate({
  topic: string,           // 必填，演示主题
  content?: string,        // Markdown 格式内容（# 标题\n- 要点）
  slides_count?: number,   // 幻灯片数量（默认 10，范围 1-20）
  theme?: PPTTheme,        // 主题名称（默认 neon-green）
  output_path?: string,    // 输出路径（默认 working directory）
  images?: SlideImage[],   // 外部图片 [{url, slideIndex, position}]
  use_masters?: boolean,   // 使用 Slide Master 模式（默认 true）
  chart_mode?: ChartMode,  // 图表模式 'auto' | 'none'（默认 auto）
})
```

## 主题

### 9 种配色主题

| 主题 Key | 显示名 | 背景色 | 强调色 | 风格 |
|----------|--------|--------|--------|------|
| `neon-green` | 霓虹绿 | #0a0a0a | #00ff88 | 深色 + 绿色霓虹 |
| `neon-blue` | 电光蓝 | #0a0f1a | #00d4ff | 深色 + 蓝色霓虹 |
| `neon-purple` | 霓虹紫 | #0f0a1a | #c084fc | 深色 + 紫色霓虹 |
| `neon-orange` | 霓虹橙 | #1a0f0a | #ff6b00 | 深色 + 橙色霓虹 |
| `glass-light` | 玻璃浅色 | #f8fafc | #3b82f6 | 浅色毛玻璃 |
| `glass-dark` | 玻璃深色 | #0f172a | #8b5cf6 | 深色毛玻璃 |
| `minimal-mono` | 极简黑白 | #ffffff | #000000 | 纯黑白极简 |
| `corporate` | 企业蓝 | #0f1729 | #1e40af | 商务深蓝 |
| `apple-dark` | 苹果暗黑 | #000000 | #0071e3 | 纯黑 + 苹果蓝极简 |

### apple-dark 特殊处理

- 纯黑背景（#000000），无装饰元素（无点阵、无发光层、无渐变尾）
- Title Master：无装饰圆环，只有标题 + 细横线
- Content Master：无卡片边框，文字直接浮在纯黑背景上
- Stats 字号更大（48pt vs 32pt）
- 检测逻辑：`bgColor === '000000'`

## Slide Master 系统

### 6 个 Master

| Master | 用途 | Placeholder | 适用布局 |
|--------|------|-------------|----------|
| `MASTER_TITLE` | 首页 | title + subtitle | — |
| `MASTER_CONTENT_LIST` | 列表/高亮内容 | title + body | list, highlight |
| `MASTER_CONTENT_CHART` | 图表页 | title + body(左) + chart(右) | chart |
| `MASTER_CONTENT_IMAGE` | 图片页 | title + body(左) + image(右) | — |
| `MASTER_HERO_NUMBER` | 复杂内容 | title only | stats, cards-2, cards-3, timeline |
| `MASTER_END` | 结尾页 | title | — |

### Master 内置装饰

每个 Master 包含固定装饰元素（在 `registerSlideMasters` 中定义）：
- **页码标签**：右上角圆角矩形 + 序号
- **标题区域**：大字号标题 placeholder
- **强调装饰**：根据主题不同的渐变、发光、条纹效果
- **apple-dark 例外**：只保留标题和细分隔线，其余装饰全部跳过

## 布局选择

### 优先级链

```
isTitle/isEnd → 对应 Master
hasImages → CONTENT_IMAGE
chartMode=auto + 有效数据 → CONTENT_CHART (chart)
isTechnical → HERO_NUMBER (cards-2)
isProcess + ≥3 points → HERO_NUMBER (timeline)
isKeyPoint + ≤4 points → CONTENT_LIST (highlight)
isComparison + ≥3 points → HERO_NUMBER (cards-2)
hasNumbers + 3-5 points → HERO_NUMBER (stats)
pointCount === 3 → HERO_NUMBER (cards-3)
pointCount >= 4 → 轮换 [cards-2, list]
pointCount <= 2 → CONTENT_LIST (highlight)
默认 → CONTENT_LIST (list)
```

### 内容检测规则

| 检测项 | 匹配范围 | 正则/条件 |
|--------|---------|-----------|
| `isTechnical` | 仅标题 | `/架构\|技术\|实现\|原理\|算法\|系统\|模块/i` |
| `isProcess` | 仅标题 | `/流程\|步骤\|阶段\|step\|phase\|stage/i` |
| `isKeyPoint` | 仅标题 | `/核心\|关键\|重点\|最重要\|价值\|意义/i` |
| `isComparison` | 标题+要点 | `/对比\|比较\|vs\|区别\|优势\|劣势\|特点/i` |
| `hasNumbers` | 仅要点 | `≥3 个要点匹配 /\d+[\d.,]*[%万亿KMB]?/i` |

### 6 种内容布局

| 布局 | Master | 渲染方式 | 适用场景 |
|------|--------|----------|----------|
| **list** | CONTENT_LIST | body placeholder 填充要点 | 5+ 个通用要点 |
| **highlight** | CONTENT_LIST | body placeholder 突出显示 | 核心价值、≤2 要点 |
| **stats** | HERO_NUMBER | 坐标：大数字卡片 + 描述 | 3-5 个数据要点 |
| **cards-2** | HERO_NUMBER | 坐标：左右两栏卡片 | 技术架构、对比分析 |
| **cards-3** | HERO_NUMBER | 坐标：三列卡片 + 序号 | 恰好 3 个并列要点 |
| **timeline** | HERO_NUMBER | 坐标：STEP 标签 + 描述 | 流程/步骤（3-4 步） |
| **chart** | CONTENT_CHART | 左侧要点 + 右侧原生图表 | 含有效数据的页面 |

### Stats 数字提取

提取规则：`/(\d+[\d.,]*[%万亿KMB+]?)\s*(分钟|小时|天|周|个月|年|倍|人|位|个|项|款|种|次)?/i`

支持中文单位自动附加：
- "节省 60%" → `60%`
- "30 分钟上手" → `30分钟`
- "从 2 小时缩短" → `2小时`
- "提升 200%" → `200%`

## 原生图表

### 图表类型选择

| 内容特征 | 图表类型 | pptxgenjs API |
|----------|----------|---------------|
| 标题含"占比/比例/份额" | doughnut（环形图） | `pptx.charts.DOUGHNUT` |
| 标题含"趋势/增长/变化" + 时间序列 | line（折线图） | `pptx.charts.LINE` |
| 标题含"对比/排名" | bar（横向柱状图） | `pptx.charts.BAR` |
| 默认 | bar（纵向柱状图） | `pptx.charts.BAR` |

### 图表生成条件

必须同时满足以下所有条件才会生成图表：

1. `chart_mode === 'auto'`
2. 标题含数据关键词（数据/统计/市场/收入/占比/增长/趋势/...）
3. ≥3 个数据点
4. 数据标签长度 ≤15 字符（排除描述性长文本）
5. 数值量级一致（max/min ≤ 1000，避免 150亿 vs 68% 同图）

### 图表样式

- 深色背景（与主题一致）
- 无外框线、无网格线
- 数据标签使用主题强调色
- 图例位于底部
- 支持用户在 PowerPoint 中双击编辑数据

## Markdown 解析

### 输入格式

```markdown
# 标题页标题
## 副标题

# 内容页标题
- 要点 1
- 要点 2
- 要点 3

# 另一个内容页
- 要点 A

# 谢谢
## 联系方式
```

### 解析规则

- `# H1` → 新幻灯片标题
- `## H2`（紧跟 H1）→ 副标题
- `- bullet` → 要点列表
- ` ```lang ... ``` ` → 代码块（保留语言标记）
- 首个 H1 → `isTitle: true`（Title Master）
- 末尾含"谢谢/感谢/Thank/Q&A/总结" → `isEnd: true`（End Master）
- `slides_count` 限制最大幻灯片数

### 无 content 时自动占位

当只提供 `topic` 不提供 `content` 时，自动生成占位内容：
- 标题页 + (slides_count - 2) 个内容页 + 结尾页
- 内容页标题从预设列表轮换（行业背景/核心价值/产品特色/...）
- 每页 3-4 个占位要点

## 降级路径

### Legacy 模式

当 `use_masters: false` 时，使用旧的坐标式渲染：
- 不调用 `defineSlideMaster()`
- 所有装饰和内容都用绝对坐标绘制
- 布局选择逻辑与 Master 模式一致
- 适用于 pptxgenjs Master API 不可用的场景

## 大纲生成（SCQA 框架）

`outlineGenerator.ts` 提供自动大纲生成：

1. 多维度搜索（3 次 web_search）收集行业数据
2. 提取关键数据和趋势
3. SCQA 结构化大纲（Situation → Complication → Question → Answer）
4. 自动为每页标注布局建议（stats/timeline/cards/list/highlight）
5. 直接调用 ppt_generate 生成 PPT

## 已修复的 Bug 清单

| # | 问题 | 根因 | 修复位置 |
|---|------|------|----------|
| 1 | isProcess 误触发 | "开发流程"等复合词在要点中匹配 | `layouts.ts` — isProcess 只检查标题 |
| 2 | 混合数量级生成图表 | 150亿 vs 68% 同一图表 | `charts.ts` — max/min > 1000 拒绝 |
| 3 | Stats 标签不可读 | 剥离数字后"编码时间节省 质量提升" | `layouts.ts` — 保留完整文本 |
| 4 | 空 placeholder 幽灵框 | HERO_NUMBER 有 body PH | `slideMasters.ts` — 移除 body PH |
| 5 | isKeyPoint 被 hasNumbers 覆盖 | "核心价值"走了 stats | `layouts.ts` — isKeyPoint 优先于 hasNumbers |
| 6 | Stats 混入无数字要点 | "2""4"等序号作为 hero number | `layouts.ts` — 过滤只含数字的要点 |
| 7 | "感谢关注"未识别为 End | End 检测只有"谢谢/Thank/Q&A" | `parser.ts` — 增加"感谢""总结" |
| 8 | 单个数字触发 stats | `points.some()` 太宽松 | `layouts.ts` — hasNumbers 阈值改为 ≥3 |
| 9 | 轮换命中 stats 无意义数字 | "未来展望"走 stats 显示"1""2""3" | `layouts.ts` — stats 从轮换池移除 |
| 10 | cards-3 丢弃第 4 个要点 | 4 要点命中 cards-3 只渲染 3 个 | `layouts.ts` — cards-3 从轮换池移除 |
| 11 | Stats 数字缺单位 | "30 分钟"→"30", "2 小时"→"2" | `layouts.ts` — 正则捕获中文单位后缀 |
| 12 | mermaid PNG 白色背景 | mermaid.ink 默认返回 JPEG | `mermaidExport.ts` — 添加 `?type=png` |

## 测试覆盖

### ppt.test.mjs（55 个用例）

| Part | 内容 | 用例数 |
|------|------|--------|
| 1 | Parser 单元测试（解析/End 检测/代码块/占位/限制） | 16 |
| 2 | Charts 检测（标准/占比/趋势/拒绝场景） | 9 |
| 3 | Themes（9 主题获取/回退/apple-dark） | 13 |
| 4 | 集成测试（5 主题/Legacy/图表/最小/占位/大量） | 11 |
| 5 | python-pptx 结构验证（slide 数/空 PH/Master/图表/装饰） | 6 |

### ppt-extended.test.mjs（82 个用例）

| Part | 内容 | 用例数 |
|------|------|--------|
| A | 布局选择精确性（每种布局 + 优先级链 + Master 映射） | 18 |
| B | 全 9 主题生成 + python-pptx 结构验证 | 36 |
| C | 边界条件（超长/特殊字符/Emoji/英文/极限 slides） | 8 |
| D | 回归验证（12 个已修复 bug 的回归测试） | 7 |
| E | Legacy vs Master 对比（一致性 + 结构验证） | 6 |
| F | 图表类型验证（BAR/DOUGHNUT/LINE） | 7 |

### 运行测试

```bash
# 基础测试
npx tsx src/main/tools/network/ppt/__tests__/ppt.test.mjs

# 扩展测试
npx tsx src/main/tools/network/ppt/__tests__/ppt-extended.test.mjs
```

**依赖**：python-pptx（Part 5 结构验证需要 `pip install python-pptx`）

## 已知限制

1. **pptxgenjs flipH 箭头 bug** — `flipH=true` 时箭头方向错误，复杂流程图建议用 mermaid_export 生成 PNG
2. **字体依赖** — Arial Black / Helvetica Neue 需系统安装，否则回退到默认字体
3. **Pillow 预览局限** — 测试中的 Pillow 渲染不支持中文字体和层叠效果，需用 PowerPoint/Keynote 验证最终效果
4. **图表配色固定** — 原生图表颜色方案暂未跟随主题强调色自动调整
