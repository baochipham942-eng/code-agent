# Agent Runtime Smoke Matrix

日期：2026-05-29

目标：把 agent runtime 的真实产品链路验收从口头风险清单变成固定矩阵。这里不替代 unit / renderer / eval 测试；它负责证明真实 app-host、真实工具执行、真实落盘和 reload 路径没有断。

## 固定命令

每个 runtime、tool execution、multi-agent、persistence、replay/eval PR 默认先跑：

```bash
npm run typecheck
npm run debt:report -- --skip-eslint --limit 15
npm run release:security-scan
```

涉及 tool search / executable tool contract 时补跑：

```bash
npx vitest run tests/unit/services/toolSearchService.test.ts tests/unit/tools/modules/search/toolSearch.test.ts tests/unit/tools/toolExecutor.protocolApproval.test.ts tests/unit/protocol/toolDefinitions.test.ts
```

涉及外部 paid model smoke 护栏时补跑：

```bash
npx vitest run tests/unit/agent/inference.artifactRetry.test.ts tests/unit/security/secretRedaction.test.ts tests/unit/mcp/logCollector.redaction.test.ts
npx tsx scripts/acceptance/paid-real-model-replay-eval-smoke.ts --dry-run --json
```

OpenAI-compatible 中转真跑示例。先用本机 secret 文件提供 key，不把 key 写进命令行或 tracked 文件；中转只暴露兼容模型时，必须同时显式给模型名和价格：

```bash
CODE_AGENT_PAID_SMOKE=1 \
CODE_AGENT_PAID_SMOKE_API_KEY_FILE=/path/to/local-secret-key-file \
CODE_AGENT_PAID_SMOKE_BASE_URL=https://tokenflux.dev/v1 \
CODE_AGENT_PAID_SMOKE_MODEL=gpt-5.2 \
CODE_AGENT_PAID_SMOKE_INPUT_USD_PER_1M=1.75 \
CODE_AGENT_PAID_SMOKE_OUTPUT_USD_PER_1M=14 \
CODE_AGENT_PAID_SMOKE_MAX_USD=0.11 \
CODE_AGENT_PAID_SMOKE_MAX_MODEL_CALLS=3 \
CODE_AGENT_PAID_SMOKE_MAX_INPUT_TOKENS=15000 \
CODE_AGENT_PAID_SMOKE_MAX_OUTPUT_TOKENS=512 \
npm run acceptance:paid-real-model-replay-eval -- --manual-paid --json
```

这组检查必须证明：

- paid smoke 默认 manual-only，不会因为 CI 或本地误触直接花钱。
- 非默认模型必须显式提供输入/输出单价，避免低估成本。
- OpenAI-compatible 中转必须通过 `CODE_AGENT_PAID_SMOKE_BASE_URL` 或 `OPENAI_BASE_URL` 显式配置；base URL 只允许 http/https origin + path，不能携带账号密码、query 或 fragment。
- 脚本会加载工作区 `.env`，也支持用 `CODE_AGENT_PAID_SMOKE_API_KEY_FILE` 从本机 secret 文件读取 key；`.env` 和 secret 文件必须保持 gitignored，不能把 provider key 写进 tracked 文件、测试快照或命令输出。
- AgentLoop 层硬限制 `maxIterations`、`maxInputTokens`、`maxOutputTokens`，输入超额会在 provider 请求前失败。
- provider transient retry 和 runtime network retry 在 paid smoke 中关闭，避免一次 smoke 随机放大成本。
- 日志、metadata、smoke 输出和 provider 错误都不能泄露原始 API key。

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

当前这条脚本证明这几段真实链路：

- `dist/web/webServer.cjs` 能以 `WEB_HOST=127.0.0.1`、随机 `WEB_PORT`、`CODE_AGENT_ENABLE_DEV_API=true` 启动。
- 真实 renderer 能打开并通过 health/auth gate。
- 触发一次可控 dev-only agent event bridge，拿到 `sessionId` 和 hook accepted 旁证。
- 真实 renderer 在 held run 中展示停止按钮，点击后能打到 app-host `/api/cancel`，并取消 dev-only active loop stub。
- 不把 swarm、完整 eval、外部模型成本和桌面写动作混进第一版。

第一版限制：

- 这条 smoke 只验证 app-host、renderer、auth gate、dev-only agent event hook 和 renderer cancel click 可达；真实长工具终止由 `npm run acceptance:tool-cancel` 兜住，还不证明真实 AgentLoop、tool result、replay/eval completeness。
- `/api/dev/emit-agent-events` 仍受显式 dev API / E2E 守门；脚本启动 app-host 时显式打开它，避免默认生产路径暴露测试注入口。

## 最小矩阵

| 场景 | 要证明什么 | 当前可用入口 | 缺口 | PR 触发条件 |
|------|------------|--------------|------|-------------|
| Long run pause/resume | 同一个 live loop 能 pause 后 resume，不丢 session/runtime state | `npm run acceptance:pause-resume` 已覆盖真实 app-host `/api/pause`、`/api/resume` 控制同一个 active loop：pause 后仍 active 且 paused，resume 后同一 loopId 恢复；runtime pause/resume unit tests 覆盖 `ConversationRuntime` 等待态 | 只剩真实模型长跑 full-stack smoke，当前不作为核心 blocker | 改 `ConversationRuntime`、`TaskManager`、run lifecycle |
| UI cancel long Bash/http | cancel 会传到真实 tool execution，子进程或请求终止，late tool result 被抑制 | `npm run acceptance:agent-runtime-app-host` 已覆盖真实 renderer 停止按钮 click 到 app-host cancel route；`npm run acceptance:tool-cancel` 已覆盖真实 app-host API cancel：长 Bash 子进程收到 SIGTERM，长 http_request in-flight 请求关闭，ToolExecutor 均返回 aborted；cancel correctness unit tests | 只剩把 UI 点击和真实长工具绑进同一条 full-stack smoke，当前不作为核心 blocker | 改 `ToolExecutionEngine`、`ToolExecutor`、Bash/http tool |
| Agent Team dependency/cancel | dependsOn gate、blocked/failed/cancelled 汇总和 run-level cancel 都在真实 Agent Team 中成立 | `npm run acceptance:agent-team` 已覆盖真实 app-host 中的 `ParallelAgentCoordinator`：上游失败后下游 blocked、运行中 agent drain parent message、run-level cancel 后 running/pending 均 cancelled；`npm run test:swarm:smoke`、`npm run test:swarm:e2e` 覆盖 IPC/event bridge 和 renderer 链路 | 只剩把真实外部模型 subagent 跑进同一条 smoke，当前不作为核心 blocker | 改 swarm、subagent、parallel coordinator |
| Restart/reload recovery | task/todo/context intervention/manual compact/replay key 能跨 reload 读回 | `npm run acceptance:session-persistence` 已覆盖真实 app-host session、session-scoped task、todo、context intervention、compact message/runtime compression state、replay key restart 读回；`npm run acceptance:manual-compact` 已覆盖真实 app-host `/api/context/compact-current` 触发 compact model boundary、生成 compaction block、替换会话消息并写入 runtime compression state；persistence unit tests；session/replay renderer tests | 只剩把 compact 后 reload 读回和 manual compact 执行合进同一条 full-stack smoke，当前不作为核心 blocker | 改 `SessionRepository`、`SessionManager`、context assembly、task persistence |
| Auto-agent replay/eval | real agent run 产出 sessionId、replayKey、telemetry completeness，Eval 能 fail/degraded | `npm run acceptance:real-agent-replay-eval` 已覆盖真实 `AgentLoop` 调用真实 `Read` 工具、telemetry 落 model/tool/event/schema、structured replay 回读，并让 `TestRunner` 的 `real-agent-run` gate 通过；`npm run eval:smoke`、相关 evaluation IPC tests | 只剩真实外部模型 auto-agent 成本链路，当前不作为核心 blocker | 改 eval、telemetry、replay、auto/subagent telemetry |
| External paid model replay/eval | 真实外部 provider 能在预算、token、timeout、retry 红线内跑通真实 `AgentLoop` + `Read` + telemetry replay | `npm run acceptance:paid-real-model-replay-eval -- --dry-run --json` 默认只做门禁 dry-run；真跑必须显式提供 `CODE_AGENT_PAID_SMOKE=1`、`OPENAI_API_KEY` 或 `CODE_AGENT_PAID_SMOKE_API_KEY_FILE`，并传 `--manual-paid`。OpenAI-compatible 中转还必须显式提供 `CODE_AGENT_PAID_SMOKE_BASE_URL` 或 `OPENAI_BASE_URL`，脚本会拒绝把凭证藏进 URL。运行时会硬限制 `maxIterations`、`maxInputTokens`、`maxOutputTokens`，关闭 provider/runtime retry，并输出预算上限、实际 token/估算成本、sessionId、replayKey、telemetry gate；换非默认模型时还必须显式提供 `CODE_AGENT_PAID_SMOKE_INPUT_USD_PER_1M` / `CODE_AGENT_PAID_SMOKE_OUTPUT_USD_PER_1M`。2026-05-29 已用 TokenFlux + `gpt-5.2` 跑通：`status=passed`、`telemetryGate.passed=true`、`dataSource=telemetry`、`modelBlocks=2`、`toolBlocks=1`、`actualEstimatedUsd=0.05761875`、`maxUsd=0.11` | 真 paid run 只能手动或 release 前执行，不进默认 CI；Anthropic/Gemini provider matrix 后续再接；代理模型列表可能不含默认 `gpt-4o-mini`，需先查 `/models` 并显式给模型和价格 | 改 provider wrapper、model router、testing adapter、eval/replay gate |

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
