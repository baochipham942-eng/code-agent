# Agent Neo 会话内生成式交互 UI 实施

基线：`origin/main` at `6b0a61d13ce1708a6217070273f43ab897691942`

## 目标

- 模型输出 `neo_ui` 声明式 JSON，Host 在 final message 后校验并签发实例。
- 桌面 IPC 与 Web HTTP domain 共用实例、事件和 Manifest 服务。
- Renderer 用原生注册表渲染 P0 组件，旧 `generative_ui` HTML 保持只读兼容。
- 批次审批只覆盖精确 scope；参数、策略或资源 revision 漂移时 fail closed。

## 切片

1. P0a：契约、Artifact 对齐、实例/事件持久化、Choice/Parameter/Metric 渲染与 replay。
2. P0b：typed action domain、Host-owned dry-run Manifest、精确授权与漂移失效。
3. P0c：Stepper/Diff/Execution surface、渐进披露、窄窗口、无障碍与隐私 telemetry。
4. 兼容与生命周期：reload、rewind、fork、delete、export、云端初始 spec 重建。
5. 验证：目标测试、变异验证、typecheck、全量 Vitest、lint、structure、Web/Renderer build、桌面/Web E2E。

## 硬边界

- 模型 spec 无权声明 Host 身份、nonce、工具名或 `approval.respond`。
- iframe 永久不获得 Host 操作能力。
- P0 不同步可变 UI state、event 或 manifest 到云端。
- 首个真实闭环只执行 no-op adapter，不修改用户资源。

## 当前实现状态

- P0a 已完成：`neo_ui` v1 契约、Host admission、三表持久化、双端原生注册表、旧 iframe 兼容、reload/export/rewind/delete。
- P0b walking skeleton 已完成：独立开关、Host-owned dry-run manifest、nonce、scope hash、revision 漂移失效、CAS 单次消费、Native/HTTP 同服务。
- P0c 已完成首批范围：7 类注册组件、单列全宽、重组件渐进披露、743px 以下 viewport focus、焦点恢复、reduced motion、隐私遥测。
- P1/P2 暂不启动：真实工具批次接入、数据探索 worker、长内容编辑、多模态标注、通用画布和组件 SDK 需要经过本切片 dogfood/decision gate。

## 验证记录

- 目标契约、Repository、Transport、安全、Renderer 和生命周期测试通过。
- Web 与 Renderer production build、typecheck、repository structure 通过。
- 全量 Vitest 的功能/结构失败已修复；剩余 6 个 30 秒超时在隔离重跑时全部通过。
- 全仓 ESLint 保留仓库既有 error 基线；本次新增核心模块为 0 error。
