# ADR-046：Surface Execution V1 —— Browser/Computer 统一为 owner-aware 执行运行时

- 状态：accepted
- 日期：2026-07-21（随 #529 / v0.28.0 合入）

## 背景

Browser 与 Computer 自动化此前是三套割裂的状态面：Managed browser 状态按 agent/进程分域、Relay 是无属主校验的全局单例 socket（任意 `tabId` 即可 attach、固定 token 由未鉴权本地配置下发）、Computer 锁按会话分域且 waiter 不可中止。审批不绑定 session/run/agent 三元组与目标/动作/有效期；stop/takeover 只有展示层语义，不能阻止已派发的 mutation 继续落地；会话里没有统一的执行时间线，截图被当成"任务已做对"的证据。基线审计（`docs/audits/neo-surface-execution-v1-completion-audit.md`）判定 P0 关键项大面积 missing/unsafe。

## 决策

1. **一套 V1 判别式合同**（`src/shared/contract/surfaceExecution.ts`）承载 Session / Target / Grant / Observation / Action / Evidence / Error：所有权统一为 `sessionId + runId + agentId` 三元组；写操作必须消费 `fresh` observation（provider generation + document/window revision 钉死），mutation、导航、revision 变化即失效；结果拆 `delivery × verification → overall`，杜绝"送达即成功"。
2. **一个 Host 运行时**（`src/host/services/surfaceExecution/SurfaceExecutionRuntime` 及其服务群）作为 Browser/Computer 共同的执行控制面：owner-scoped session、grant 生命周期、可中止操作队列、pause/takeover/stop/end_session 单一状态机、host 强制的 capability registry。Provider 收敛为 adapter（Managed / Relay / External；Computer 走 Stateful CUA adapter），不再各自持有产品合同。
3. **Relay 信任边界重建为协议 v2**：capability 握手 + 显式 tab lease（borrow/return，记录原窗口位置）+ Agent Window + 真实输入方法 + `operation.cancel`；Host 与扩展两侧都校验 owner/grant/domain/action/expiry。wire 目录 `resources/browser-relay-extension/protocol-v2.js` 与 `src/shared/contract/browserRelay.ts` 同源对账。
4. **一条会话执行体验投影**：`SurfaceConversationProjectionService` → IPC `domain:surfaceExecution`（getSnapshot/getFrame/getOutput/control）→ renderer 单一 store，Session Header / Semantic Timeline / Evidence Card（captured→analyzed→verified 三态）/ Permission / Takeover / Recovery 卡片与 PiP 全部消费同一状态源。

## 影响

- 旧 tool 名、历史消息、replay、session export 保持可读（dual-read 投影）；`useComputerUsePip` 降级为兼容入口，转发 `useSurfaceExecutionPip`。
- 敏感面收紧：Cookie/token/剪贴板/输入内容不进明文日志、proof 与导出（`surfaceExecutionRedaction` + export sanitizer 全链 canary）；Profile Cookie Import 改为 Host 签发 approval，调用参数 `userConfirmed: true` 不再视为授权。
- 验收证据化：`scripts/acceptance/surface-execution-*` 产出 `docs/acceptance/surface-execution/` 下的 proof（含协议红线、stop 基准、跨 surface 切换、durable 重启恢复、真机 WorkBuddy 闭环），并接入发版稳定性证据门。
- 遗留边界见 `docs/architecture/surface-execution.md` §边界与 backlog（远程池、Windows/Linux provider、外部 `neo surface` adapter 等仍属 P2）。
