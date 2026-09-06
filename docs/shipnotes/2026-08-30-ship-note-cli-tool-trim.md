# Ship Note — feat/cli-tool-trim（--tools / --disallowed-tools 工具面裁剪）

> 日期：2026-08-30 · 分支：feat/cli-tool-trim（headless orchestration PR1/5，基点 origin/main 8662142d3 → rebase 到 7654d4403）

## What / Why

`neo run` / `neo chat` 新增 `--tools <allowlist>` 与 `--disallowed-tools <denylist>`（逗号分隔，大小写不敏感，支持 `skill:<name>` 前缀，语义对齐 Codex CLI 的 `--disallowed-tools`），供 headless 编排按任务收窄模型可见工具面。

- **schema 面**：复用既有 run policy（`AgentLoop` 的 `allowedToolNames`/`deniedToolNames` → `filterToolsByRunPolicyObserved` + 延迟工具摘要过滤 + tool_search deny 继承），被裁剪工具从模型可见面移除。
- **执行层兜底闸**：`ToolExecutor.execute` 在 subagentPolicy 闸前新增 run policy 硬拒——嵌套 PTC 调用 / 直接 executor 调用也跑不掉，报错 `Tool not allowed: <name> (disabled by --tools/--disallowed-tools)`，并与 `recordDecision`（policy-deny）配对，权限账本不断流。
- **白名单语义（已固化到 flag help）**：精确白名单，**无核心工具兜底保留**——名单外的工具（含 AskUserQuestion）一律禁用；deny 优先于 allow。白名单条目会触发延迟工具预载，所以 `--tools skill:pdf` 可直接用上技能工具。
- **spawn_agent 收窄**：父 run 面沿 ToolContext → protocol ctx → SubagentExecutionContext 传递，在父子工具交集之外再收一次（穿透 parentContext 空集的退化分支），子代理只能收窄、永不扩张；并沿 spawn 链透传给孙代理。
- **opt-in**：不传 flag 时 `allowedToolNames`/`deniedToolNames` 均为 undefined，各层短路，行为与此前逐字节一致（CLI/web/desktop 共享 src/host 路径零分叉）。

## 结构

纯函数真源收敛到 `src/host/tools/runToolPolicy.ts`（ToolExecutor 与 AgentLoop 共用同一份语义）；`agent/runtime/toolRunPolicy.ts` 退为 RuntimeContext 包装层 + 收窄可观测性（导出与行为不变）。

## 验证证据

- `npm run typecheck` 0 错；`npm run build:cli` 成功；`npm run lint` 0 error（subagentExecutor 卡 max-lines 1000 硬限，收窄逻辑拆到 `subagentExecutorToolDefs.ts`）；knip dependency gate 绿；tests/scripts tsc 棘轮（scripts/tsc-tests-ratchet.mjs，CI Swarm smoke 门）0/0 不增；host 文件被 web/desktop 共享，`npm run build` 全量构建通过。
- 新增单测：`cli/toolListFlags`（flag 解析 5）、`tools/runToolPolicy`（纯函数语义 9）、`tools/toolExecutor.runToolPolicy`（执行层硬拒 + 清晰报错 + 账本配对 6）、`tools/toolRegistryFilter`（registry deny 含 skill: 2）、`cli/commands`（run flag threading 1）、`agent/subagentExecutionContext`（run 面透传 1）。
- 全量 `npx vitest run`（rebase 后基点 7654d4403）：2570 文件过 / 4 跳过，22060 过 / 0 测试失败；唯一失败文件 `tests/renderer/components/mediaAssetLightbox.browser.test.ts` 是 afterAll `browser.close()` 10s 钩超时（重负载环境 flake，本分支零 renderer 改动），该文件在分支与 origin/main 基线上单独跑均通过；origin/main 基线全量 2567 文件 / 22036 测试全绿（exit 0）。
- E2E（真模型 glm-5.3-flash，sandbox /tmp/neo-e2e-tooltrim，`--output-format stream-json`）：
  - control（无 flag）：2+2 → "4"，无工具调用，成功。
  - `--disallowed-tools Bash` + 要求跑 ls：Bash 不在 schema 面；模型 `ToolSearch select:Bash` 被拒（"未找到匹配的工具"），明确报告 Bash 被裁剪，改走 ListDirectory 完成任务。
  - `--tools ListDirectory` + 要求 Bash 跑 ls：只有 ListDirectory 被调用，模型报告 Bash 不可用并等效完成。
  - 强制逐字调 Bash：模型无法发起调用，原样带回 ToolSearch 确切报错。

## 偏差与遗留

- 执行层兜底闸的报错文案固定引用 CLI flag 名；web/desktop 宿主收窄走到同一闸时文案同样清晰但未区分来源（当前宿主路径的工具调用必先过 AgentLoop/messageProcessor 拦截，兜底闸实际只对嵌套/直接调用生效）。
- tool_search 的候选排序不按 allowlist 过滤（allowlist 下延迟工具摘要已收窄、执行层硬拒，属展示层遗留）。
