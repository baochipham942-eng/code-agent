# Agent Runtime Smoke Matrix

日期：2026-05-20

目标：把 agent runtime 的真实产品链路验收从口头风险清单变成固定矩阵。这里不替代 unit / renderer / eval 测试；它负责证明真实 app-host、真实工具执行、真实落盘和 reload 路径没有断。

## 固定命令

每个 runtime、tool execution、multi-agent、persistence、replay/eval PR 默认先跑：

```bash
npm run typecheck
npm run debt:report -- --skip-eslint --limit 15
npm run release:security-scan
```

涉及浏览器或 UI 状态时，优先用系统 Chrome + CDP：

```bash
npm run acceptance:browser-computer-system-chrome -- --json
```

## 下一条脚本

已新增第一版 `acceptance:agent-runtime-app-host`，复用 `browser-computer-app-host-smoke.ts` 的 app-host 启动、health check、系统 Chrome + CDP 和 JSON 输出模式。

```bash
npm run acceptance:agent-runtime-app-host
npm run acceptance:agent-runtime-app-host -- --skip-build --json
```

第一版只证明一条真实链路：

- `dist/web/webServer.cjs` 能以 `WEB_HOST=127.0.0.1`、随机 `WEB_PORT`、`CODE_AGENT_ENABLE_DEV_API=true` 启动。
- 真实 renderer 能打开并通过 health/auth gate。
- 触发一次可控 dev-only agent event bridge，拿到 `sessionId` 和 hook accepted 旁证。
- 不把 swarm、完整 eval、外部模型成本和桌面写动作混进第一版。

第一版限制：

- 这条 smoke 只验证 app-host、renderer、auth gate 和 dev-only agent event hook 可达；还不证明真实 AgentLoop、tool result、replay/eval completeness。
- `/api/dev/emit-agent-events` 仍受 `CODE_AGENT_E2E=1` 守门；脚本启动 app-host 时显式打开它，避免默认生产路径暴露测试注入口。

## 最小矩阵

| 场景 | 要证明什么 | 当前可用入口 | 缺口 | PR 触发条件 |
|------|------------|--------------|------|-------------|
| Long run pause/resume | 同一个 live loop 能 pause 后 resume，不丢 session/runtime state | runtime pause/resume unit tests；app-host 手验 | 还缺固定 app-host smoke script | 改 `ConversationRuntime`、`TaskManager`、run lifecycle |
| UI cancel long Bash/http | cancel 会传到真实 tool execution，子进程或请求终止，late tool result 被抑制 | cancel correctness unit tests | 还缺长 Bash/http 的真实 UI/API smoke | 改 `ToolExecutionEngine`、`ToolExecutor`、Bash/http tool |
| Agent Team dependency/cancel | dependsOn gate、blocked/failed/cancelled 汇总和 run-level cancel 都在真实 Agent Team 中成立 | `npm run test:swarm:smoke`、`npm run test:swarm:e2e` | e2e 依赖 Playwright 环境，CI 失败时需本机证据 | 改 swarm、subagent、parallel coordinator |
| Restart/reload recovery | task/todo/context intervention/manual compact/replay key 能跨 reload 读回 | persistence unit tests；session/replay renderer tests | 还缺统一 reload smoke | 改 `SessionRepository`、`SessionManager`、context assembly、task persistence |
| Auto-agent replay/eval | real agent run 产出 sessionId、replayKey、telemetry completeness，Eval 能 fail/degraded | `npm run eval:smoke`、相关 evaluation IPC tests | 还缺真实 AgentLoop + tool + replay 的一条固定 smoke | 改 eval、telemetry、replay、auto/subagent telemetry |

## 验收记录格式

每个 PR 描述里必须保留这段，没跑的项写清原因：

```md
Runtime smoke:
- typecheck:
- debt:report:
- release:security-scan:
- targeted tests:
- real smoke:
- skipped smoke and reason:
```

## 边界

- 不用外部网站、真实账号、远程浏览器池做默认 smoke。
- 需要 macOS 桌面权限的动作允许本机手验，但必须贴命令、目标 app、失败/成功截图或日志摘要。
- CI 没有桌面权限时，system Chrome + CDP 可以作为 browser/UI 层证据；desktop write action 仍需本机记录。
- smoke 只证明真实链路可达，不替代更细的 unit tests。
