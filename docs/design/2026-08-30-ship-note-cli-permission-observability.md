# Ship Note — feat/cli-permission-observability（P4 审批卡 + 观测收口）

> 日期：2026-08-30 · 分支：feat/cli-permission-observability（3 commits，基点 origin/main ee7f58c60）

## 范围

1. **0f1db6fc9** `feat(cli)`：Ink TUI 交互权限审批卡（Grok Build 式 blocking card：工具名+参数摘要，Allow once / No, reject / Always allow 会话级前缀，1-3 直选，Esc/Ctrl+C 以 denialSource:'user' 拒绝且不取消 turn）；permissionPolicy 新增交互审批注册点，headless 结构性 fail-closed 不变。StatusBar 钉物理顶行：动态块全高 + layout.ts 精确行预算，Static scrollback 不再顶走 StatusBar；单行合成 StatusBar（cwd 截断防折行）。
2. **d96984b5b** `fix(cli)`：CLI run 边界包 run 级 RunTraceContext，日志行带 sessionId/traceId/runId（ALS 隔离并发会话）；CLI 绑定 TelemetryCollector 到自己的 SQLite（与桌面共享 DDL applyTelemetrySchema），session timeline 的 Telemetry turns 不再恒为 0。
3. **chore(knip)**：棘轮修平（删投机导出、测试专用导出落 baseline）。

## 验证证据

- 全量 `npx vitest run`（结果见 PR CI；本地前置跑通过后提交）
- typecheck 0 错、build:cli 成功、eslint 0 新增、knip 三门全绿
- 审批卡 pty 端到端 6/6：卡片出现 / 1 once / 2 reject / Esc reject（turn 继续）/ 3 always / always 后同前缀不再问；真链路集成测试（真 ToolExecutor+classifier+permissionPolicy）approve/deny/headless fail-closed 各验
- 钉顶行：30 turn 60 条消息灌入后末帧 row 0 仍为 StatusBar
- 观测：真实 glm-5.3-flash 会话 `neo session timeline` Telemetry turns=2/1（修复前恒 0）；日志 grep sessionId 命中 11 行

## 偏差与遗留

- "Always allow" 为会话级内存，不写 exec-policy.json（持久通道现成：getExecPolicyStore，后续可接）
- 审批卡在窄终端按定值 6 行预算，未纳入编辑器窗口算法
- TurnCostPersistence 仍直连主 DatabaseService，CLI 下每轮一条既有警告（可用同款 dbOverride 思路后续收口）
- CLI 非 debug 模式文件日志只写 ERROR 行（设计如此），INFO 级 correlation 行需 --debug
