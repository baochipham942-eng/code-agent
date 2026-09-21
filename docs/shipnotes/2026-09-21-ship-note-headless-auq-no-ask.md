# Ship note · 2026-09-21 · headless 跑批 AskUserQuestion 无人应答废轮（issue #1994）

## 问题

headless/管道跑批（`neo run -p`、`neo serve`、管道喂入的 `neo chat`、`--json`）里
AskUserQuestion 永远无人应答。模型白问一轮后工具返回带 `awaitingUserInput` 的
安全拒绝，引擎进入问句未答冻结、当轮禁止写操作——跑批场景这一轮直接作废。
夜跑 2026-09-20 无人值守跑批：`<awaiting-user-input>` 拦截出现 15 次/12 会话。

## 修法

复用现有信号，不新造平行机制：

- `src/host/agent/runtime/toolRunPolicy.ts` `filterToolsByRunPolicy`：
  `ctx.unattendedTurn === true`（现有信号：`originKind==='headless'` / 会话级无人值守
  标记，ADR-068 D4）时把 `ASK_USER_QUESTION_TOOL_NAMES` 两个等价名移出模型可见
  工具面；收窄走既有 `filterToolsByRunPolicyObserved` 可观测性日志（点名 removed）。
  有人值守轮原样保留——交互模式（TUI/桌面/Web）行为不变。
- `src/cli/commands/chatOriginKind.ts`（新纯函数）+ `chat.ts`：chat 入口 stdin 非
  TTY（管道）或 `--json` 时声明 `originKind='headless'`，接入既有
  originKind → unattendedTurn 链路（`cli/bootstrap.ts`）。TTY 交互（Ink TUI /
  readline）不声明。`neo run` / `serve` / `debug` 此前已声明 'headless'，自动受益。
- 执行层 no-renderer / timeout 的「安全拒绝 + 冻结」兜底不变：工具名单在推理
  装配后、投递前路由消失的竞态仍被原有分支接住。

## 测试证据

- static-contract：`npm run typecheck` 0 错误；`npm run gates:fast` 绿
  （receipt=7fc0c4f2-e0fe-446c-9303-da5ba7053500，绑 HEAD f85f88003）。
- hermetic-protocol：
  - `tests/unit/agent/toolRunPolicy.test.ts` 11 过（新增 4：unattended 滤两个
    等价名 / 白名单捞不回 / 有人值守保留 / 收窄日志点名）；
  - `tests/unit/cli/chatOriginKind.test.ts` 3 过（管道→headless、--json→headless、
    TTY→不声明）；
  - 相关既有套件 147 过（askUserQuestion / userQuestionPrompt / adapter.cliAgent /
    bootstrap.durableRun / serveCommand / userQuestionRoutes / agentOrchestrator）。
- fault-injection（反向变异）：
  - 变异 1：`toolRunPolicy.ts` 把 `ctx.unattendedTurn === true` 改成 `false` →
    toolRunPolicy 单测 3 红（unattended 过滤与白名单捞回、收窄日志），还原后 11 全绿；
  - 变异 2：`chatOriginKind.ts` 让函数恒返回 `undefined` → chatOriginKind 单测
    2 红（管道/--json 判 headless 两条），还原后 3 全绿。
- 未做 real-runtime：改动是工具面过滤 + 入口声明，无协议/UI 变化；headless 真机
  复跑留给出夜班跑批自然验证（原本 15 次/12 会话的拦截应归零），风险可接受。

证据档位：static-contract + hermetic-protocol + fault-injection
