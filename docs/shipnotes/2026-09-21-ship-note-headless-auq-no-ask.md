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

- static-contract：`npm run typecheck` 0 错误；`npm run gates:fast` 绿。
  回执由 gates/ship 流程按当时 HEAD 滚动生成、落 `.reports/gates-fast/`（ship pr/merge
  会复核回执与 HEAD 绑定），本档不固化某个 sha 的回执号——文档后续修订会顶出新
  HEAD，固化即过期（ai-review PR#2009 连打两次同因）。
- hermetic-protocol：
  - `tests/unit/agent/toolRunPolicy.test.ts` 12 过（新增 5：unattended 滤两个
    等价名 / 白名单捞不回 / 有人值守保留 / 收窄日志点名 / unattended 时重试指引
    不再声称 AskUserQuestion 可用）；
  - `tests/unit/cli/chatOriginKind.test.ts` 3 过（管道→headless、--json→headless、
    TTY→不声明）；
  - 相关既有套件 147 过（askUserQuestion / userQuestionPrompt / adapter.cliAgent /
    bootstrap.durableRun / serveCommand / userQuestionRoutes / agentOrchestrator）。
- fault-injection（反向变异）：
  - 变异 1：`toolRunPolicy.ts` 把 `ctx.unattendedTurn === true` 改成 `false`，原始红行：
    ```
     FAIL  tests/unit/agent/toolRunPolicy.test.ts > toolRunPolicy > 无人值守轮 AskUserQuestion 收口 > unattendedTurn=true 时两个名字等价形都移出工具面
    AssertionError: expected [ 'AskUserQuestion', …(3) ] to deeply equal [ 'Read', 'Bash' ]
     FAIL  tests/unit/agent/toolRunPolicy.test.ts > toolRunPolicy > 无人值守轮 AskUserQuestion 收口 > 无人值守 + 显式白名单也不许把 AskUserQuestion 捞回来
    AssertionError: expected [ 'AskUserQuestion', 'Read' ] to deeply equal [ 'Read' ]
     FAIL  tests/unit/agent/toolRunPolicy.test.ts > toolRunPolicy > 无人值守轮 AskUserQuestion 收口 > 无人值守收窄也走可观测性日志（点名 removed）
          Tests  3 failed | 8 passed (11)
    ```
    还原后 11 全绿；
  - 变异 2：`chatOriginKind.ts` 让函数恒返回 `undefined`，原始红行：
    ```
     FAIL  tests/unit/cli/chatOriginKind.test.ts > resolveChatOriginKind > stdin 非 TTY（管道喂入）→ headless
    AssertionError: expected undefined to be 'headless' // Object.is equality
     FAIL  tests/unit/cli/chatOriginKind.test.ts > resolveChatOriginKind > --json 模式即使 stdin 是 TTY 也按 headless（输出给机器消费）
          Tests  2 failed | 1 passed (3)
    ```
    还原后 3 全绿。
- 未做 real-runtime：改动是工具面过滤 + 入口声明，无协议/UI 变化；headless 真机
  复跑留给出夜班跑批自然验证（原本 15 次/12 会话的拦截应归零），风险可接受。

证据档位：static-contract + hermetic-protocol + fault-injection


## ship 回执
✓ gates:fast passed required local preflight. schema=2 head=20c2aeb87e9fc5269cef6d57f0eb57254349743f base=7f353a4fec5d2526531dbbf93c5f086fec8ad664 receipt=3d96e18e-5bd0-448f-ad04-09abc0b195bd
