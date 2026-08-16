# ADR-058：devModeAutoApprove 显式通道与机器批准留痕

- 状态：accepted（产品负责人 2026-08-14 拍板）
- 日期：2026-08-16
- 关联：ADR-057 审批拒绝来源可观测性；N-L10S3

## 背景

`devModeAutoApprove` 的意图是让 Dev 测试包与 `cargo tauri dev` 保留免确认体验。旧实现有两处安全语义错位：

1. `ConfigService.isDevModeAutoApproveEnabled()` 用 `isProduction()` 守门，但 Dev 测试包也是 release
   构建，Rust 会给 web server 注入 `NODE_ENV=production`。按构建 profile 判断会把 Dev 包一并关死。
2. 审批主路径绕过守卫，直接读取原始设置；放行后 `ToolExecutor` 又把批准来源写死为 `user`。
   生产包可能因此放行，事后账本还无法区分机器批准和真人批准。

Rust 的 `dev_slot()` 已给每个 Dev 通道注入独立 `CODE_AGENT_DATA_DIR`（`.code-agent-dev`、
`.code-agent-dev2` 至 `.code-agent-dev9`）。这个身份同时决定数据隔离与测试包槽位，适合作为 host
判断 Dev 通道的运行时真源。

## 决策

1. `devModeAutoApprove` 只在 `CODE_AGENT_DATA_DIR` 的末级目录通过共享严格解析器
   `devSlotFromDataDirName()` 时生效。`.code-agent`、`.code-agent-developer`、`.code-agent-dev-old`、
   `.code-agent-dev02` 和越界槽位全部拒绝。`NODE_ENV` 与 `app.isPackaged` 不再参与这个开关的通道判断。
2. `ConfigService.isDevModeAutoApproveEnabled()` 是唯一有效性守卫。Orchestrator 通过注入回调调用它，
   不再读取 `settings.permissions.devModeAutoApprove` 决定放行。设置恢复仍可保留原始偏好，但生产通道
   即使读到 true 也不能生效。
3. Dev 自动批准沿用已有 `PermissionAskResult` 富结果，自报
   `approvalSource: 'dev-auto-approve'`。不改 `ToolContext` 的窄 boolean 判定契约，也不把任一
   `if (!approved)` 调用点改成接收对象。
4. 同一来源同时进入三类证据：host 日志明确写 `Machine-approved via devModeAutoApprove`；
   append-only `permission_decisions.reason` 写 `dev-auto-approve`；approval telemetry 写
   `approval.approval_source=dev-auto-approve`。旧 boolean true 继续按真人批准 `user` 兼容。
5. `forceConfirm`、directory access、无人值守/语音停车审批、声明式只读 MCP 豁免与分级
   `autoApprove` 的顺序和行为保持不变。

## 后果

- Dev release 包与 `cargo tauri dev` 继续免确认，生产包不再受原始开关值影响。
- 审计可直接按 `permission_decisions.reason='dev-auto-approve'` 过滤机器批准，并与
  `reason='user'` 的真人批准分开。
- Dev 通道身份依赖 Rust 注入的数据目录。若未来更换槽位命名或注入变量，必须同步更新共享
  dev-slot 契约与正反例测试，不能在 ConfigService 另写宽松匹配。

## 验收边界

单元与集成门需要锁住四件事：release `NODE_ENV` 下严格 Dev 槽仍识别；近似目录全部拒绝；
生产通道原始开关 true 仍发出审批请求；持久化账本输入能按 `dev-auto-approve` 与 `user` 分组。
最终发布判断仍要求真实 Dev 包正例和真实生产包负例；代码路径与单测只算前置证据。
