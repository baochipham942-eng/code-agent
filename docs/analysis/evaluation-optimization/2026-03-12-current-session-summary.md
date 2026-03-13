# Code Agent 评测优化总结

## 背景

本轮分析围绕 `code-agent` 现有评测中心、实验执行、日志沉淀、人工标注和业界 agent eval 方法论展开。分析同时结合了：

- 当前仓库实现
- CC 历史讨论中给出的关键网站
- 一批 ExcelMaster / SpreadsheetBench / Dashboard / 方法论截图

结论是：当前系统已经有评测中心雏形，也有会话回放、评分配置、实验执行、失败分析等部件，但整体仍然停留在“多个评测相关功能并存”的阶段，还没有收敛成统一、可审计、可回流的评测平台。

## 本轮参考资料

### 方法论和平台参考

- Hamel: https://hamel.dev/blog/posts/evals-faq/index.html
- Anthropic: https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- LangSmith Evaluation: https://docs.langchain.com/langsmith/evaluation
- LangSmith Observability: https://docs.langchain.com/langsmith/observability
- Arize Phoenix evals: https://arize.com/docs/phoenix/evaluation/llm-evals
- DeepEval: https://deepeval.com/

### 截图样本参考

来自 `~/Desktop/评测/` 的产品后台页、Dashboard、PPT 和研究截图，用于补齐页面设计、字段组织和 reviewer workflow 视角。

## 已确认的现状

### 1. 评测中心前端已成型

入口：

- `src/renderer/components/features/evalCenter/EvalCenterPanel.tsx`

现有页面覆盖：

- 会话评测
- 实验总览
- 测试集
- 评分配置
- 实验详情
- 失败分析
- 对比分析

结论：

- 不是空壳
- 但很多页面还没共享统一主模型

### 2. 主进程 IPC 和 service 基础完整

入口：

- `src/main/ipc/evaluation.ipc.ts`
- `src/main/evaluation/EvaluationService.ts`
- `src/main/evaluation/experimentAdapter.ts`
- `src/main/evaluation/annotationProxy.ts`

覆盖能力：

- 单会话评测
- 主观评测
- 测试报告读取
- 标注保存
- 测试用例列表
- 评分配置读写
- 实验创建、列表、详情
- 失败漏斗
- 跨实验对比

结论：

- 后端不是没实现
- 问题主要在统一性和闭环性

### 3. 评测引擎存在，但稳定性评测未进入主链路

相关实现：

- `src/main/testing/testRunner.ts`
- `src/main/testing/statisticalRunner.ts`

关键结论：

- `StatisticalRunner` 已存在
- 但主实验创建流仍直接走 `TestRunner`
- `trialsPerCase` 在 UI/IPC 中出现，但没有驱动真实稳定性执行

这使得：

- `pass@k`
- `pass^k`
- `flakiness`

更多停留在概念层，而不是真实产品能力。

## 当前核心问题

### P0. 数据平面分裂

当前至少有三套数据面：

- 会话评测：`telemetry + evaluations`
- 实验评测：`experiments + experiment_cases`
- 文件报告：`test-results/*.json`

影响：

- 页面之间看到的“同一个实验”并不一定是同一份数据
- 无法形成稳定 run identity

### P0. 多个实验页面实际上依赖“最新报告文件”

已确认页面：

- `ExperimentDetailPage.tsx`
- `FailureAnalysisPage.tsx`
- `CrossExperimentPage.tsx`

问题：

- 这些页面很多时候并不是按 `experimentId/runId` 精确取数
- 而是读取 `LIST_TEST_REPORTS` 后加载最近报告

影响：

- 历史复盘不稳
- 并行实验不稳
- 对比分析语义不准

### P0. `subset` 和 `trialsPerCase` 存在实现缺口

问题一：`subset`

- 前端使用 `subset:${fileName}` 的字符串方式编码子集
- 后端没有对其进行正式实体解析

问题二：`trialsPerCase`

- 参数存在
- 但没有真正切到 `StatisticalRunner`

影响：

- 子集提跑真实性存疑
- 稳定性评测名不副实

### P1. 会话评测与实验评测没有统一主模型

现在更像两条独立系统：

- 会话线：`session -> replay -> subjective eval`
- 实验线：`test set -> runner -> report`

影响：

- 单题轨迹难以自然进入 run/case 分析
- 人工标注和 AI 建议难以共面沉淀

### P1. 日志已存在，但还不是统一 trace

现有日志资产：

- telemetry turns
- telemetry tool calls
- session events
- replay data
- runner outputs

问题：

- schema 不统一
- 页面消费方式不统一
- grader/reviewer 无法共享同一条 trace 视图

### P1. 缺 reviewer-first 工作流

当前系统更像开发者测试工具，缺少：

- 单题详情页
- reviewer queue
- rubric 渲染视图
- trace + grading + annotation 共面

## 结合参考资料后的重构方向

### 1. 统一主模型

建议主链路：

- `Dataset`
- `Run`
- `CaseRun`
- `Trace`
- `Review`

其中：

- Dataset 解决测试集/子集/来源/可信度
- Run 解决提跑、版本、配置、环境
- CaseRun 解决单题结果和多 trial
- Trace 解决 replay、grader、observability
- Review 解决人工标注和 AI 建议

### 2. 页面重构

建议主页面：

- `Overview`
- `Datasets`
- `Runs`
- `RunDetail`
- `CaseDetail`
- `TraceView`
- `ReviewQueue`
- `RunCompare`
- `ScoringConfig`

最关键新增页：

- `RunDetailPage`
- `CaseDetailPage`
- `TraceView`
- `ReviewQueuePage`

### 3. 评测集治理

建议把评测集来源分层：

- 公开 benchmark
- 内部黄金集
- 生产失败回流集
- 合成扩展集

每个 case 必须带：

- 来源
- 版本
- trust level
- 是否人工审核
- 是否进入 golden/regression

### 4. 日志与 trace 标准化

必须统一纳入 trace 的内容：

- turn 输入输出
- tool calls
- code execution log
- retry/timeout/error
- artifacts
- grading evidence
- review decisions

### 5. grader registry 和版本化

从“评分配置页面”升级为：

- grader config 管理
- judge prompt version 管理
- score threshold 管理
- 发布/归档能力

## 网站借鉴映射

### Hamel

借鉴：

- 小而高质量黄金集
- error analysis 优先
- reviewer-first 界面

落点：

- Dataset
- CaseDetail
- ReviewQueue

### Anthropic

借鉴：

- `pass@k / pass^k / flakiness`
- 环境稳定性
- human calibration

落点：

- RunDetail.Analysis
- StatisticalRunner 主链路

### LangSmith

借鉴：

- `dataset -> experiment -> evaluator -> compare`
- 在线/离线统一心智模型

落点：

- Dataset/Run 数据模型
- RunCompare

### Phoenix

借鉴：

- trace + eval 共面
- grader explanation/evidence

落点：

- TraceView
- grader_results

### DeepEval

借鉴：

- regression testing
- pytest/CI 集成
- metric 抽象

落点：

- CI 触发 eval run
- grader config 版本化

## 推荐排期

### P0：修闭环和真实性

- 修 `subset`
- 接入 `StatisticalRunner`
- 新建 `eval_runs / case_runs / traces / reviews` 基础表
- 让实验详情/失败分析/对比全部按 `runId` 取数
- 建立 `trace_id`

### P1：补单题工作流

- 新建 `CaseDetailPage`
- 升级 `SessionReplayView -> TraceView`
- 新建 `ReviewQueuePage`
- grader evidence 结构化

### P2：补长期飞轮

- 生产失败会话回流 dataset
- judge-human calibration
- regression gating
- grader versioning

## 结论

本轮分析的核心结论不是“系统缺很多页面”，而是：

- 当前系统已经有不少先进部件
- 但它们还没有被收敛成统一评测平台

最优先的工作不是继续横向加功能，而是先修三件事：

- 统一对象模型
- 统一日志/trace
- 统一页面按实体取数

这三件事做完之后，稳定性评测、人工标注、AI 优化建议、生产回流和对比分析才会真正形成闭环。
