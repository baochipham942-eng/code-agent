# 设计 Tab 重规划 + 厚版演示稿 — 整体 Plan

> 状态:**✅ 全部交付（PR #260，9 commit）** | 创建:2026-06-22 | 决策人:林晨
> 决策已定:① 4 媒介 tab 结构 ② 演示稿走厚版(真排版) ③ 原型改名网页
> as-built 见 `docs/architecture/design-mode.md §15`。一期(4 媒介+5 修)+ 二期(厚版全链路)+ 4 增强(品牌注入/AI 大纲/像素预览/AI 配图)均已实现 + 端到端 dogfood 验收。

## 1. 目标

把设计 tab 从「4 个并列产物类型(交互原型/设计稿/信息图/视频)」重规划为**按交付形态分的 4 媒介**,并补齐已识别的 UI 缺陷;新增「演示稿」厚版生成链路。

最终结构:

```
[网页]  [图 ▾]  [演示稿]  [视频]
         └ [设计稿] [信息图]   ← 仅「图」激活时出现的二级切换
```

分类依据 = 交付形态(用户视角「我要做一个 ___」),对齐 Canva AI / Lovart;设计稿+信息图天然同属「图」,合并。

## 2. 现状与可复用资产

| 资产 | 位置 | 复用于 |
|---|---|---|
| Tab 控件 + 配置面板 | `DesignWorkspace.tsx:163-203` | 一期重构 |
| 产物类型 enum | `designTypes.ts:47` `'prototype'\|'mockup'\|'infographic'\|'video'` | 新增 `'slides'` |
| 设计 i18n | `i18n/zh.ts:29-32`(label) `:109`(导出) `:152/156`(免费/累计) | 改名+新键 |
| 画布 PPTX 导出(薄) | `services/design/pptxExport.ts` + `DesignCanvas.tsx:715-735` | 保留,前置入口 |
| **完整 PPT 引擎** | `tools/media/ppt/`(parallelPptEngine/layouts/slideMasters/designScaffold/illustrationAgent/charts) | **二期厚版核心** |
| PPT 生成工具壳 | `tools/modules/network/pptGenerate.ts` + `.schema.ts` | 二期参考输入契约 |
| 品牌契约注入管线 | 现有(我的品牌 → 每次生成) | 二期演示稿注入 |
| 成本透明/历史 | `DesignCostHistory.tsx` + `pricing.ts` | 两期沿用 |
| 就地文本编辑(CD-Parity) | `DesignCanvas.tsx` | 二期逐页改字 |

关键认知:厚版演示稿 ≈ 把 `parallelPptEngine` 从「agent 工具调用」改成「设计 tab IPC 直调」,喂品牌契约+大纲,渲染回画布。**不是造轮子**。

## 3. 一期:Tab 重构 + 5 修复(~1 天)

纯 UI/IA,不碰生成能力,立即可见。隔离 worktree + TDD。

### 3.1 Tab 重构
- [ ] `designTypes.ts`:`DesignOutputType` 增 `'slides'`(数据模型不动旧 4 值,只加)
- [ ] `DesignWorkspace.tsx:163-203`:主控件改 4 媒介 `[网页][图][演示稿][视频]`;「图」激活时渲染二级 `[设计稿][信息图]`,内联 segmented 非下拉。UI 层把 `mockup`/`infographic` 归到「图」分组,选中态映射到二级
- [ ] `i18n`:`outputPrototype` 文案 `交互原型`→`网页`;新增 `outputSlides`/二级标签键;en.ts 同步
- [ ] 各 tab 配置面板按差异化显隐(网页无尺寸/无生图模型;图有;视频有模式/时长;演示稿见二期)

### 3.2 五个修复
- [ ] **图标间距**:审 `BrandManager.tsx:145/343` 的 `<Button leftIcon={<Plus/>}>` 与「从参考图提取」(ImageDown)按钮的 gap,缺则补(优先查 Button 组件 leftIcon 是否漏 margin,根治胜过逐个补)
- [ ] **`window.prompt('标注文字')`** `AnnotationLayer.tsx:115`:换 i18n + 画布内输入,去掉原生系统弹窗
- [ ] **「累计花费 免费」矛盾** `DesignCostHistory.tsx:51/142` + `zh.ts:152/156`:未发生花费(累计=0 且无步骤)时不显示绿色「免费」,改为隐藏或「—」;「免费」仅保留给 costCny=0 的免费档模型语义
- [ ] **空状态文案统一**:网页/画布两 tab 措辞对齐(统一讲「做什么 + 结果出现在哪」)
- [ ] **PPTX 导出发现性**:`DesignCanvas.tsx:715-735` 从「画布有图才冒出右上角」移到固定工具栏(配合新结构,演示稿/图 tab 常驻导出区)

### 3.3 一期验收
- typecheck 净;设计相关 targeted 测试绿
- headless 截图:4 媒介切换 + 图二级切换 + 5 修复点逐一目检
- 隔离 worktree,截图给林晨验收,不动主树

## 4. 二期:厚版演示稿(~1-2 周,单独立项)

### 4.1 流程(两步 + 大纲控制点)
```
① 写需求 → [生成大纲]
② AI 大纲(可改):每页 标题+要点+配图意图;可增删/拖拽/改字
   → [生成演示稿]
③ parallelPptEngine 逐页排版(注入品牌契约) → 渲染回画布
   → 逐页就地改文字(复用 CD-Parity)
④ 导出 PPTX(pptxgenjs) / PDF
```

### 4.2 任务拆解
- [ ] **契约勘探**:读 `parallelPptEngine` + `pptGenerate.schema.ts` 输入/输出契约,确认能脱离 agent 工具上下文直调(开放项,二期开工首件)
- [ ] **大纲生成 IPC**:需求 → 结构化大纲(标题/要点/配图意图),设计 tab 专用 handler
- [ ] **大纲编辑器组件**:增删页/拖拽排序/就地改字(渲染态,不入 DB)
- [ ] **逐页渲染编排**:大纲 + 品牌契约 → parallelPptEngine → 页图回灌画布(挂 variant spine)
- [ ] **就地文本编辑接入**:复用 CD-Parity 能力到演示稿页
- [ ] **成本预估**:按页数 × 模型在 `pricing.ts` 估,出图前可见
- [ ] **导出**:PPTX/PDF,沿用现有导出机制
- [ ] **对抗审计**:子 agent 当反方,2-4 轮收敛(SSRF/路径越界/成本计量对称性)

### 4.3 二期验收
- 全链路真 key dogfood(出大纲→改→渲染→改字→导出 PPTX 可被 PowerPoint/WPS 打开)
- TDD + codex-audit/multi-review;隔离 worktree,merge 走 --no-ff

### 4.4 R1 勘探结论(一期会话已做,2026-06-22)
- `prepareSlidesConcurrently`(parallelPptEngine.ts:82)= 纯函数,吃 `SlideData[]`+`ThemeConfig`,**不耦合 agent 上下文** ✓
- `outlineToSlideData(topic, slides_count)`(parser.ts)= **确定性大纲**,不依赖 LLM ✓(二期「生成大纲」可先确定性、后 LLM 增强)
- 编排逻辑全在 `executePptGenerate`(pptGenerate.ts:144,~700 行 ToolModule),耦合工具调用语义;**当前无 service 层**
- **结论**:引擎核可复用,二期主活=把「topic/内容 → SlideData → pptx」核心从 `executePptGenerate` 抽成 `services/design/slidesGenerator`,tool 与新设计 IPC 共用。ADR 级抽取重构(R1=中风险,符合原估),工期维持 ~1-2 周。

## 一期交付状态(2026-06-22)
✅ 已实施 + typecheck 净 + 设计测试 177+6 全绿 + headless 截图逐 tab 验收。
分支 `feat/design-tab-restructure`(worktree code-agent-tabreplan),commit f7bae8bfe,未推未合待拍板。

## 5. 风险与开放项
- **R1** parallelPptEngine 与 agent 工具上下文耦合度未知 → 二期首件勘探,若强耦合则退回「薄版+排版增强」
- **R2** 主树并发(多会话在途)→ 全程隔离 worktree + symlink node_modules
- **R3** 演示稿出图成本(逐页付费)→ 大纲控制点先让用户确认页数,成本前置可见
- **R4** Button leftIcon 若根治会影响全局按钮 → 改前 grep 全量引用,回归截图

## 6. 里程碑
| 期 | 内容 | 工期 | 产出 |
|---|---|---|---|
| 一期 | Tab 重构 + 5 修复 | ~1 天 | worktree + 截图验收 |
| 二期 | 厚版演示稿全链路 | ~1-2 周 | 单独立项 + dogfood + 审计 |

建议:一期先合,让新 IA 上线收集反馈;二期按 R1 勘探结果再细化排期。
