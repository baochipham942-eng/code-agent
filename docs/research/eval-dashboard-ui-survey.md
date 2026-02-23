# LLM 评估框架前端/Dashboard UI 调研报告

> 调研日期：2026-02-08
> 覆盖框架：Inspect AI, promptfoo, Braintrust, LangSmith, Langfuse, W&B Weave, HELM, Arize Phoenix, HumanLoop

---

## 一、各框架详细分析

### 1. Inspect AI (UK AISI)

**Log Viewer** — 评估日志查看器

| 视图 | 描述 |
|------|------|
| Overview Dashboard | 评估摘要 + 样本结果网格，支持增量实时预览 |
| Sample Details Panel | 三标签页：Messages（对话历史）、Scoring（输入/目标/答案）、Metadata |
| Log History Menu | 右上角导航，列出所有评估日志及摘要统计 |
| VS Code Extension | 四面板：Configuration、Tasks、Logs、Task CLI 参数 |

**亮点**：增量实时预览（评估未完成即可查看中间结果）、样本交叉对比（跨 epoch 查看同一样本）、可打包为静态网站发布到 HuggingFace Spaces。

### 2. promptfoo

**Web Viewer** — 矩阵式评估结果查看器

| 视图 | 描述 |
|------|------|
| Main Eval Viewer | 核心界面，表格式展示评估结果 |
| Charts Section | 可切换的图表区域（Pass Rate、Score Distribution 直方图、Scatter Plot） |
| Cell Detail View | 单元格详情，完整输出 + 提示词 + 变量 + 评分 |

**交互模式**：
- 多模式筛选：All / Failures / Passes / Errors / Different / Highlights
- 高级过滤：`=`、`contains`、`>`、`<` 运算符
- 缩放控制：50%-200%
- 单元格悬停操作：详情、手动评分 0-1、评论、高亮
- 多格式导出：YAML、CSV、JSON、DPO JSON（偏好训练）、Burp payloads
- Cmd+K 评估选择器
- URL 参数持久化

**亮点**：DPO 训练数据导出、Red Team 攻击向量过滤、评分持久化构建训练数据集。

### 3. Braintrust

**全栈评估平台**

| 视图 | 描述 |
|------|------|
| Experiments | 评估结果和历史对比 |
| Datasets | 测试数据集管理 |
| Playgrounds | 零代码交互式评估工作区 |
| Logs | 生产日志查看 |
| Project Overview | 项目级别汇总 |

**可视化组件**：Results Grid（三种布局：Grid/List/Summary）、Diff Mode（高亮差异）、Trace Viewer（side-by-side 输出对比）、实时 Dashboard（token/延迟/错误率）。

**亮点**：零代码 Playground、生产 trace 回放、自动回归检测、子秒级性能。

### 4. LangSmith (LangChain)

**可观测性 + 评估平台**

| 视图 | 描述 |
|------|------|
| Prebuilt Dashboards | 六大监控区：Traces、LLM Calls、Cost & Tokens、Tools、Run Types、Feedback |
| Custom Dashboards | 用户可配置图表集合 |
| Trace Detail View | 树形结构的运行详情，父/子 run 层级 |
| Experiments View | 多模型 side-by-side 对比 |
| Threads View | 多轮对话视图 |

**亮点**：Insights Agent（AI 自动分析 trace 模式）、自动预建仪表板（零配置）、多轮 Eval（语义意图/结果/轨迹）。

### 5. Langfuse

**开源可观测性平台**

| 视图 | 描述 |
|------|------|
| Dashboard | 拖放式 Widget 仪表板（折线图/柱状图/时间序列/饼图） |
| Traces | 嵌套观测树 |
| Log View | 线性日志视图，Cmd+F 全文搜索 |
| Agent Graphs | Agent 工作流图谱（自动推断） |
| Score Analytics | 评估器对齐分析 |

**亮点**：Log View（线性拼接所有步骤，适合调试复杂 Agent）、Agent Graph 自动推断、Score Analytics（评估评估器本身的准确性）。

### 6. W&B Weave

**评估 + 可观测性**

| 视图 | 描述 |
|------|------|
| Traces | 调用栈层级展示 |
| Evaluations | Side-by-side 评估对比 |
| Leaderboards | 聚合评估排行榜 |
| Playground | 提示词沙箱 |

**亮点**：Leaderboard 概念（跨评估聚合排行）、Trace Tree 自动聚合延迟和成本。

### 7. HELM (Stanford)

**学术排行榜**

| 视图 | 描述 |
|------|------|
| Leaderboard | 模型 x 场景 x 指标 矩阵 |
| Scenario Detail | 单场景详细结果 |
| Model Detail | 单模型全场景表现 |
| Individual Prompts | 单条提示词检查 |

**亮点**：七维全面评估（含公平性/偏见/毒性）、所有原始提示词和响应完全公开透明。

### 8. Arize Phoenix

**开源 LLM 可观测性**

| 视图 | 描述 |
|------|------|
| Trace Detail | 三标签：Tree + Timeline + Agent Graph |
| UMAP 可视化 | 嵌入向量降维聚类 |
| Experiments | Agent 版本对比 |

**亮点**：三种 Trace 视图切换（树形/时间线/流程图）、UMAP 嵌入聚类可视化、Span Replay 重放调试。

### 9. HumanLoop（已停服，仅供参考）

**Prompt 管理 + 评估**

**亮点**：Spider Plot 雷达图（多维性能总览）、渐进式评估配置流程、版本 Diff 高亮。

---

## 二、跨框架通用模式

### 核心页面结构

| 页面类型 | 覆盖框架数 |
|----------|-----------|
| Trace/运行详情 | 6/9 |
| 评估/实验对比 | 9/9 |
| 数据集管理 | 6/9 |
| 仪表板/监控 | 4/9 |
| Playground/Editor | 5/9 |
| 排行榜 | 2/9 |

### 核心可视化组件

| 组件 | 使用框架 | 用途 |
|------|----------|------|
| 结果表格/矩阵 | 全部 | 基础数据展示 |
| Trace 树/调用链 | LangSmith, Langfuse, Phoenix, Weave | 执行流调试 |
| 折线图/时间序列 | LangSmith, Langfuse, Inspect Viz | 趋势监控 |
| 柱状图 | LangSmith, Langfuse, promptfoo | 类别对比 |
| 散点图 | promptfoo | 头对头模型对比 |
| 雷达图 | HumanLoop | 多维性能总览 |
| Diff 视图 | Braintrust, HumanLoop, promptfoo | 版本变更对比 |
| 热力图 | Inspect Viz, HELM | 密集模型x场景对比 |
| Agent Graph/DAG | Langfuse, Phoenix | Agent 工作流可视化 |
| Timeline/Waterfall | Phoenix, LangSmith | 执行时间分布 |

### 核心交互模式

| 模式 | 覆盖率 |
|------|--------|
| Filter + Sort | 9/9 |
| Drill-down（概览→详情） | 9/9 |
| Side-by-side 对比 | 6/9 |
| 在线人工标注/评分 | 4/9 |
| Replay/Playground | 4/9 |
| URL 状态持久化 | 2/9 |
| 拖放布局 | 1/9 |
| 键盘快捷键 | 2/9 |
| 多格式导出 | 3/9 |

### 最佳实践总结

**数据展示**：表格为王 + 渐进式细节 + 颜色编码（绿=通过/红=失败）

**对比分析**：Side-by-side 是最核心交互 + Diff 高亮 + 自动回归检测

**调试追溯**：Trace 树可视化 + 多视图切换 + Replay 能力

**可配置性**：Widget 化仪表板 + 自定义列/过滤器 + 预设模板

**协作分享**：URL 分享 + 标注/评论系统 + 不可变实验快照
