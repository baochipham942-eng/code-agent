# Ship Note — feat/cli-perm-auto（--permission-mode auto 颗粒度 headless 权限档）

> 日期：2026-08-30 · 分支：feat/cli-perm-auto（headless orchestration PR2/5，基点 origin/main 15951f6c6 → rebase 到 9f4f34b04；与 #1492 的 chat.ts 冲突解法：permission-mode 校验与 inkRunner 预载并行共存）

## What / Why

`neo run` / `neo chat` 新增 `--permission-mode auto`：headless 权限的**中间档**，介于现有 fail-closed 默认（无审批 UI 时凡是 ask 一律拒）与 `--dangerously-skip-permissions`（全量放行，含危险操作）之间。语义参考 Codex CLI 的 granular approval policy：

- 走到审批处理器的请求再经 `permissionClassifier` 裁决一次：判 `approve` 的安全类（只读工具、工作区/临时目录内写入、安全命令）自动批准；`ask` / `deny` / 分类器故障一律 **fail-closed 拒绝**，并给出模型可转述的真实原因与出路。
- **硬门不让路**：`forceConfirm`（信任边界 W3 写边界 / readOnly 档 / GuardFabric / 确认门控）与 decisionTrace 里的硬门步骤（`policy_enforcer`（tools.always_confirm）、`guard_fabric`、`plugin_hook`、`command_analysis_failed`、`skill.allowed-tools-boundary`、`shell_desktop_automation`）到达处理器时分类器根本没机会判（或已判被压），auto 档绝不替它们放行——handler 再跑一遍分类器会得到更宽的结果，那是必须堵住的扩权口。
- **交互通道优先**：Ink TUI 审批卡已注册时（chat TTY）auto 档不抢答；auto 是 headless 档，不是交互模式替代品。
- **互斥与默认值**：`--permission-mode auto` 与 `--dangerously-skip-permissions` 同用 → 干净 CLI 报错 exit 1；非法取值同样报错；不传 flag 行为逐字节不变。

## 设计选择：CLI handler 层，不动 modes.ts（scope guard 结论）

实现在 `src/cli/permissionPolicy.ts` 的 `createCLIPermissionHandler`，**没有**给 `src/host/permissions/modes.ts` 的 `PermissionMode` 加第八个档。理由：

1. `PermissionMode` 是 desktop/web 会话档共享枚举（MODE_CONFIGS、PermissionModeManager、renderer 档选择器、`permissionModeAutoApproves` 终审判定）。加一个只在 headless 有意义的档会迫使所有消费面处理一个它们永远不生产的值。
2. CLI 的审批收口点天然是 `createCLIPermissionHandler`——skip / no-approval-ui / Ink 交互通道都已在该处分流，auto 是同层的第四个分支。
3. web/desktop 面**零改动验证**：`permissionPolicy.ts` 的全部 importers 是 CLI（bootstrap / run / chat / tui-app）；`modes.ts` 未触碰；对 shared 的唯一改动是 `PermissionAskResult.approvalSource` 联合类型**加法**新增 `'cli-auto-approve'`（非导出类型、optional 字段、消费方无一做穷尽 switch，见下）。

## 与既有决策链的关系（不 bypass  anything）

- auto 档作用于 **requestPermission 处理器**，位于 toolExecutor 决策链最末端——exec-policy `forbidden`（:1127）、validateCommand 硬毙、GuardFabric、subagentPolicy、schema 闸全部在它之前已生效，auto 无条件够不到它们。
- **账本零绕过**：handler 放行的请求由 toolExecutor 既有 `recordDecision`（ask-approved）落 decision trace + 权限账本，`approvalSource: 'cli-auto-approve'` 作为来源标记写进 trace step（`审批放行（来源：cli-auto-approve)`）与账本 reason 列；`ToolLedgerOrigin` 仍是 `cli`。机器来源同时**不会**触发 exec-policy 的 `learnFromApproval`（该学习门仅放行 `undefined|'user'`，:1477）——auto 批准不会污染持久化规则层。
- **基线实测结论（重要）**：当前 headless `neo run` 的 executor 层分类器本就在自动批准安全类并入账（`auto-approve`/`safe-command`/`写入项目目录内`，origin `cli`）——auto 档的 handler 级裁决是**第二道兜底**，覆盖绕过 executor 分类的路径（forcePermissionHandler 运行、directive-memory headless 探针等），并把这套语义固化成显式、可测、有互斥校验的契约，而不是改变主路径的默认行为。

## 验证证据

### 静态门（全绿）

- `npm run typecheck` 0 错；`npm run build:cli` 成功；`npm run lint` 0 error（改动 5 个源文件 eslint 0 warning）。
- `npm run gates:local`（scripts/gates-local.mjs，PR CI 的本地镜像）：**38/38 全绿**（含 knip dependency gate / knip production ratchet ×2 / tsc-tests-ratchet / eslint-ratchet / host-esm-cjs / 静态门组 / 主链 vitest 子集 / swarm smoke+e2e / webserver boot / renderer bundle）。

### 单测

- `tests/unit/cli/permissionPolicy.test.ts`（+15）：flag 解析（合法值/非法值/互斥）、auto 放行只读工具·安全命令·工作区内写入（approvalSource=`cli-auto-approve`）、fail-closed 拒绝工作区外写入·危险命令·未知命令·forceConfirm·五种硬门 trace、交互通道优先于 auto、warn 不在放行时输出。
- `tests/unit/tools/toolExecutor.decisionTrace.test.ts`（+2，端到端 handler×executor×账本，forcePermissionHandler 强迫每个工具过 handler）：工作区内写入 → 执行成功 + 账本 `ask-approved`/`cli-auto-approve`（sink 断言 origin=`cli`）；工作区外写入 → fail-closed + 工具零执行 + 账本 `ask-denied`/`no-approval-ui`。
- 全量 `npx vitest run`（分支，基点 15951f6c6）：2580 文件过 / 4 跳过 / 1 失败，22129 测试过 / 1 失败 / 7 跳过 / 29 todo。唯一失败 `tests/renderer/components/ExpertPanel.test.tsx`（setProactivity waitFor 超时）为全量负载 flake：该文件在本分支与 origin/main 基线（bba715975）单独跑均 36/36 通过，且本分支零 renderer 改动（PR1 的 lightbox flake 同类）。分支失败集 ⊆ 基线失败集成立。

### E2E（真模型 glm-5.3-flash，sandbox /tmp/neo-e2e-permauto，`--output-format stream-json`）

- control 无 flag 只读（"list files…"）：成功，`ListDirectory` 直通，零权限拒绝。
- control 无 flag 写入（"create hello.txt"）：**成功**——`Write` 被 executor 分类器自动批准（账本 `auto-approve`/`写入项目目录内`，origin `cli`）。即"现有行为"本就包含安全类自动批准，auto 档将其显式化而非新造（见偏差节）。
- `--permission-mode auto` 只读（`ls -la`）：成功，零拒绝；账本 `policy-allow`（exec-policy 规则层照常先生效，未被 bypass）。
- `--permission-mode auto` 工作区内写入（auto2.txt）：成功，账本 `auto-approve`/`写入项目目录内` + `safe-command` 各一条。
- `--permission-mode auto` 越界写入（Write → `$HOME/neo-e2e-boundary-probe.txt`）：**fail-closed 拒绝**——handler 日志 `--permission-mode auto 拒绝: Write … 该操作被标记为必须人工确认（forceConfirm），auto 档不放行`；模型随后尝试的复合 shell 探针命令亦被拒（`ask-denied`/`no-approval-ui` 入账）；目标文件确认未创建；模型终答如实转述拒绝原因与出路（GUI 或显式 skip）。
- `--permission-mode auto` + `--dangerously-skip-permissions`：干净报错 `互斥…请只保留一个`，exit 1；非法取值 `--permission-mode bogus` 同样 exit 1。

## 偏差与遗留

- 任务书 e2e 预期 (b)「create hello.txt 被拒绝」与实测现状不符：/tmp sandbox 内写入走分类器 W1/W2（工作区内/临时目录）本就自动批准（无 flag 亦然）。本 PR 按 spec 的功能语义执行（工作区内写入=安全类→放行），fail-closed 证据改用确定性越界写入（$HOME 探针）呈现。
- auto 档的 handler 上下文取 `process.cwd()` 派生的 workspace 权限（与 ToolExecutor 基座 `writeWorkspaceRoot` 同一份 `resolveBackgroundWorkspaceAuthority` 宽度校验）；run 级 executor 的 workspaceScope 与 cwd 不一致的假设场景（CLI 当前不产生）下 handler 判定以 cwd 为准。
