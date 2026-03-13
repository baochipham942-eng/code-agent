# Code Agent 会话功能优化总结

## 背景

本轮分析主要围绕 `code-agent` 的会话能力、会话日志、回放与评测链路之间的关系展开。结论是：当前仓库的会话基础设施已经具备一定成熟度，但“会话对象”“会话日志”“评测对象”之间仍然没有完全统一，导致会话能力更像运行态能力，而不是完整的可复盘、可评审、可回流资产。

相关代码入口：

- `src/main/session/*`
- `src/main/agent/sessionPersistence.ts`
- `src/main/evaluation/replayService.ts`
- `src/main/evaluation/sessionEventService.ts`
- `src/main/evaluation/sessionAnalyticsService.ts`
- `src/renderer/components/features/evalCenter/SessionReplayView.tsx`

## 已确认的现状

### 1. 会话持久化存在，但定位偏“恢复运行态”

- `sessionPersistence.ts` 会把 agent session 存到 `~/.code-agent/agent-sessions`
- 这套机制适合恢复和续跑
- 但它不是评测意义上的标准化会话归档

结论：

- 会话存档有了
- 会话资产化还没有完成

### 2. 会话回放能力相对成熟

- `replayService.ts` 能基于结构化 telemetry 重建 replay
- `SessionReplayView.tsx` 能展示 turn、tool call、error、thinking 等信息
- 这说明会话不是只有最终文本，而是已经保留了中间轨迹

结论：

- “查看会话日志/回放”这条能力已经有较好基础
- 后续应升级为更正式的 `TraceView`

### 3. 会话事件记录存在，但 schema 还不够统一

- `sessionEventService.ts` 已经在存 event stream
- 当前更像通用事件归档，而不是为 grader/reviewer 设计的 trace schema
- 不同来源日志结构并不完全一致

结论：

- 会话日志是“有数据”
- 但还不是“统一可复用的 trace 对象”

### 4. 会话评测与实验评测仍然是两条线

- 会话评测更接近 `session -> replay -> subjective evaluation`
- 实验评测更接近 `test set -> runner -> report`
- 两者没有共享统一的 `run/case_run/trace/review` 数据模型

结论：

- 当前会话功能与评测功能耦合点不够稳定
- 会话对象无法自然进入长期回归和失败分析飞轮

## 会话功能的核心问题

### P0. 会话对象没有成为平台一级实体

表现：

- 会话能运行、能保存、能回放
- 但没有稳定的 `session -> trace -> review -> dataset case` 映射

影响：

- 无法把真实生产会话自然沉淀为 regression case
- 无法从单次会话稳定追踪到后续评测、人工标注和优化建议

### P0. 日志源分裂

当前存在至少三类会话相关数据：

- session persistence 存档
- telemetry turns/tool calls
- evaluation/session events

影响：

- 不同页面读取的数据面不同
- 回放、评测、人工标注容易引用不同语义层的数据

### P1. 回放 UI 更像开发者工具，而不是 reviewer 工作台

当前 `SessionReplayView` 的优势是技术细节可见，但不足是：

- 缺业务对象化视图
- 缺基于 case/rubric 的渲染
- 缺审阅动作入口
- 缺 grader evidence 和 review history 共面展示

影响：

- 工程师能看
- 但研究员、评测员、产品负责人不容易高效用

### P1. 会话日志缺少统一可审计 ID 链

建议统一这些 ID：

- `session_id`
- `trace_id`
- `run_id`
- `case_run_id`
- `review_id`

如果没有这条 ID 链：

- 单条会话很难进入完整闭环
- 人工标注也很难严格绑定到具体执行版本

## 建议的会话能力重构方向

### 1. 把 Session 升级为 Trace 驱动对象

建议主链路：

- `Session`
- `Trace`
- `TraceEvent`
- `Review`

其中：

- Session 负责运行生命周期
- Trace 负责评测、回放、分析

### 2. 用统一 trace schema 收敛所有日志

建议纳入统一 schema 的内容：

- turn 输入输出
- tool 调用参数与结果
- code execution stdout/stderr/exit code
- retry/timeout/interruption
- thinking 摘要
- artifacts

### 3. 将 `SessionReplayView` 升级为 `TraceView`

目标变化：

- 从“回放日志”
- 变成“trace inspection + grading + review”中心页

最低要求：

- 事件筛选
- tool/code/error 分组
- grader evidence
- review 操作
- 跳转 case/run

### 4. 生产会话回流数据集

建议增加明确通路：

- 生产会话失败
- 人工确认
- 生成 dataset case
- 进入 regression subset

这会让会话功能真正参与评测飞轮，而不是只做留痕。

## 推荐的近期任务

### P0

- 建立 `trace_id`，贯穿 session、replay、evaluation
- 会话回放页深链到 case/run/review
- 统一 `session persistence + telemetry + session events` 的读取适配层

### P1

- 新建 `TraceView`
- 支持 trace 级 grader evidence 展示
- 支持 trace 级人工 review

### P2

- 支持从会话一键生成 regression case
- 支持会话失败模式自动聚类
- 支持生产会话质量看板

## 总结

当前 `code-agent` 的会话功能不是没有基础，而是基础能力已经具备，但还没有被提升为正式平台对象。

最关键的下一步不是继续堆会话 UI，而是把会话、轨迹、日志、评测、人工审阅收敛成一条统一数据链。只有这样，“会话功能优化”才会真正转化为质量改进和模型/agent 能力提升。
