# Ship Note — feat/ink-shell-passthrough（neo CLI 交互体验第一批 P0）

> 日期：2026-08-30 · 分支：feat/ink-shell-passthrough（1 commit）
> 依据：docs/competitive/grok-codex-借鉴清单.md P0 项 A1 / A6

## 范围

P0（执行链路）：

1. **`!` shell 直通修进 Ink 路径（A1）**：此前 Ink TUI 的 submit 无 `!` 分支，
   `!cmd` 被当 prompt 发给模型（行为陷阱）。新增唯一通道
   `src/cli/commands/shellPassthrough.ts`（`runDirectShellCommand`），Ink 与
   readline 共用，走 ToolExecutor 正式链路——权限分类器/审批卡（权限证据）、
   审计账本、输出截断、cwd、超时全部继承；readline 路径的 execSync 直通
   （chat.ts，绕权限分类器的历史欠账）同步收口进同一通道，execSync 已删除。
2. **shell 输出截断展示（A6）**：bash 成功输出此前在工具块完全不可见；现按
   Grok 规格显示前 2 行 + 后 3 行，中间一行 `… (N more lines)` 省略标记
   （`src/cli/tui-app/shellOutput.ts` 纯函数）；`!` 直通结果复用同一渲染。
   同类工具归组加 `›` 明细：Ctrl+X 全局切换展开/折叠（动态区即时生效；
   已封口进 `<Static>` 的消息不回溯，Ink 限制）。

## 验证证据

- **全量**：`npx vitest run` 22051 passed / 0 failed（2570 文件全绿）@ 2754d84dc
- **质量门**：typecheck 0 错；`npm run build:cli` 成功；eslint 改动文件 0 告警；
  knip 三门全过（ratchet / --profile production / production-ratchet）
- **新单测**：`shellOutput`（截断规则 6 例）、`shellCommand`（bash outputLines +
  `!` 消息块追加/收口 5 例）、`shellPassthrough`（正式链路 + fail-closed 3 例）
- **pty 端到端**（/tmp/neo-p0-sandbox，`!` 真实按键驱动）：`!echo` 输出可见且
  工具块收口 `Ran`；`!seq 1 8` 截断省略标记出现；`/exit` exit 0 干净退出。
  脚本 `/tmp/neo-p0-sandbox/pty_shell_passthrough.py`（两个坑已固化：pty 需
  TIOCSWINSZ 设窗口否则 Ink 不渲染；prompt 出现 ≠ raw mode 就绪，须等 ICANON
  关闭再打字且全程 drain，否则按键被 cooked 行规程 echo 冒充草稿）
- **非 TTY 回归**：`(sleep 5; printf '/exit\n') | node dist/cli/index.cjs` exit 0

## 偏差与遗留

- `!` 直通结果不进入会话上下文（与 readline 历史行为一致）；如需模型可见另行设计
- 归组展开（Ctrl+X）只影响动态区；已封口消息不回溯（Ink `<Static>` 一次性渲染）
- 本机用户级 exec-policy.json 含 `allow git reset` / `allow rm -rf`，交互审批卡
  的实机验证走 P1 批（改用未被 policy 覆盖的 `chmod 777` 触发）
