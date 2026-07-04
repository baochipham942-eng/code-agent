# Codex Audit Report — agent-badge-routing-truth

**Date**: 2026-07-03
**Scope**: HEAD~4..HEAD（批主体 4 commits，起始基线 563ff27a2 = 三层一致性批② 合入点）
**Branch**: fix/agent-badge-routing-truth
**Rounds run**: 4 / 4
**Converged**: ✅ yes（Round 4 "converged — no findings"）

## Summary

| Round | HIGH | MED | LOW | Fix commit |
|-------|------|-----|-----|------------|
| 1     | 0    | 1   | 1   | 25016c143（另含自审发现 d0e4bfe3f） |
| 2     | 0    | 2   | 0   | 7a9e2b147 |
| 3     | 0    | 2   | 0   | 509ae26c4（1 修 + 1 by-design） |
| 4     | 0    | 0   | 0   | —（收敛） |

## Findings by Round

### Round 1

#### 🟡 MEDIUM — 外部引擎会话绕过 preferredAgentId 路由真相块（web /api/run）
**Finding**: 外部引擎分支（codex_cli/claude_code/mimo_code/kimi_code）在 agent.ts 的 preferredAgentId 处理块之前提前 return，显式 /agent 选择被完全静默忽略，无 routing_resolved、无降级信号，chip 继续谎报。
**Resolution**: ✅ fixed in 25016c143 — 引擎分支内发降级 routing_resolved（fallbackAgentName=引擎展示名 + 自定义 reason），renderer 既有降级链自动清选择 + toast。builder 扩展 fallbackAgentName/fallbackReason 保持单一真源。
**Why**: 正是本批要杀的「静默分叉」同族，Codex 抓到了本批实现自身的盲区。

#### 🟢 LOW — agentRegistrySSEBridge 静默吞错（无日志）
**Finding**: 桥的 catch 完全吞掉 list/broadcast 失败，Electron IPC 路径同场景有 warn 日志，诊断轨迹缺失。
**Resolution**: ℹ️ recorded, not fixed — 独立文件单 LOW，按 LOW-bundling 规则只记录。失败语义（跳过本次推送、下次变更重试）已在代码注释中写明。

#### （自审补充，非 Codex finding）🟡 — preferredAgentId 未 trim 导致假降级
**Finding**（Claude 自审）: `" explore "` 经 resolver 内部 trim 解析成功（id='explore'），但 requestedAgentId 保留原始串 → `requestedAgentId !== agentId` 误判降级（徽标误报「未生效」+ mode 误判 auto）。
**Resolution**: ✅ fixed in d0e4bfe3f — orchestrator resolveTurnRouting 与 web /api/run 两入口对称 trim；全空白视同无显式选择。

### Round 2

#### 🟡 MEDIUM — Electron IPC 路径同款外部引擎旁路（agentAppService.sendMessage）
**Finding**: Round 1 只修了 web 路径；agentAppService.sendMessage 的引擎分支在 withWorkbenchTurnSystemContext（preferredAgentId → agentOverrideId）之前 return，同样静默。经典 symmetric application。
**Resolution**: ✅ fixed in 7a9e2b147 — 新增 TaskManager.emitAgentEventForSession（走 orchestrator onEvent 同链广播），引擎分支前对称发降级事件。
**Why**: Claude 在 Round 1 对称检查时只核了 interruptAndContinue/createSession 的 fail-loud throw，漏了 sendMessage 引擎分支。Codex caught a real issue I missed。

#### 🟡 MEDIUM — 引擎 kind 裸串（codex_cli）泄进 UI toast
**Finding**: fallbackAgentName 直接用 engine kind，routingDegradation toast 原样展示 `codex_cli`。
**Resolution**: ✅ fixed in 7a9e2b147 — 新增 AGENT_ENGINE_LABELS 单一真源（shared/contract/agentEngine.ts），registry descriptor 5 处 label 同步改引，两处 emit 站点用展示名。

### Round 3

#### 🟡 MEDIUM — fallbackReason 仍插值裸 kind
**Finding**: agentName 改了展示名但 reason 字符串仍是 `External engine session (codex_cli)...`，路由证据详情 UI 会透出 reason。
**Resolution**: ✅ fixed in 509ae26c4 — 两处统一 engineLabel 变量，测试断言 reason 不含裸 kind。

#### 🟡 MEDIUM — 活跃 run 的 steer/interrupt 携带 preferredAgentId 不重路由
**Finding**: Electron interruptAndContinue 的 agentLoop.steer 分支忽略 agentOverrideId；web /api/interrupt 的 toWorkbenchMetadata 剥掉 preferredAgentId。中途换 agent 意图不生效且无信号。
**Resolution**: ℹ️ by-design（不修）— steer 语义 = 不换当前 run 的执行者；选择不丢失（per-session store 保留，下一整轮正常路由并发 routing_resolved 真相事件）；若发降级事件会误清仍然有效的 pending 选择。web /api/interrupt 无活跃 loop 直接 409，不存在绕过路由起新 run 的通道。回合徽标恒显 RuntimeContext 实际执行者，真相面不受影响。Round 4 已请 Codex 对此判定出具裁决。

### Round 4

**Result**: converged — no findings。
**By-design 裁决**: Codex 认可 steer 判定原文："agree; steer/interrupt preserves the live executor mid-run, keeps the per-session selection pending for the next full turn, and /api/interrupt returns 409 without an active loop."

## Deferred Items (not fixed this cycle)

- steer 中途换 agent 的「下轮生效」提示：可选的 info 级信号，与本批降噪主题冲突，未做。
- web 路径 assistant 消息 metadata（turnQuality）不落库：**存量 gap（非本批引入）**——live 流上的 message 事件带完整 turnQuality（dogfood 已证），但 /api/run 的持久化链丢 metadata，reload 后徽标消失。建议后续批立项。

## LOW Findings (informational, no commit)

- agentRegistrySSEBridge 吞错无日志（Round 1）。

## Convergence Analysis

四轮趋势 1MED+1LOW → 2MED → 2MED(收窄) → 0（收敛）。本批最大教训与批②一致且再次验证：**对称应用是 Round N+1 的第一杀手**——Round 1 修 web 引擎旁路后，Round 2 立刻在 Electron IPC 同位置抓到镜像旁路；Round 3 又在同一修复的 reason 字符串里抓到残留。「一个修复的 siblings 清单」应显式包含：另一条 run 路径、同函数的字符串插值处、同一数据的所有 UI 透出面。
