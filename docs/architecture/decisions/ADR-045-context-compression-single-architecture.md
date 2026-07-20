# ADR-045：上下文压缩单一架构，删除旧三层 `checkAndCompress` 入口

- 状态：accepted
- 日期：2026-07-20

## 背景

生产链路已经由 `CompressionPipeline` 生成 L0-L5 projection 与压力信号，`ContextPressureController` 统一裁决，`CompactionService` 执行可审计的 summary compaction。旧 `AutoContextCompressor.checkAndCompress()` 没有生产调用方，却继续保留 Observation Masking、truncate、code extract、AI summary 等另一套行为与测试，造成代码、文档和线上事实分裂，也留下 #513 P1-3 已标出的待决边界。

## 决策

上下文压缩的唯一架构为：

`CompressionPipeline (L0-L5) → ContextPressureController → CompactionService`

删除 `checkAndCompress()` 及其独占策略、helper、常量和死测试；删除同样只服务旧历史改写路径的 `observationMask`、`compressMessageHistory` 与状态包装逻辑。不保留兼容入口。

## 影响

删除：旧三策略选择与执行、AI summary 失败回退、Observation Masking、历史消息就地改写、激进截断、旧 block/指定位置压缩、文档感知压缩，以及只验证这些实现细节的测试。

保留：`AutoCompressionConfig` 中仍被健康配置和压力裁决消费的字段；`AutoContextCompressor` 的配置读取/更新、绝对 token 阈值、compaction 计数/统计、wrap-up 与单例初始化；`CompressedMessage` 类型；工具结果压缩、token 估算和主动压力检测。

调用方不再需要理解两套压缩顺序、错误回退和历史改写语义。压缩行为与测试集中到生产 seam，后续变更通过 Pipeline、PressureController 或 CompactionService 的接口验证。
