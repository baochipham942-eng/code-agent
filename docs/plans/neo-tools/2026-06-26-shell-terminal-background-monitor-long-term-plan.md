# Shell / Terminal / Background Monitor 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇归 **WP-F「Shell 控制面」**，推荐优先级 **5**。要点：
> - 本篇最成熟，命令级权限 DSL / Process 读写权限拆分 / 后台任务重启恢复方向都对，整体保留。
> - **重启恢复与 tool-platform-agents 篇的 SpawnGuard durable 是同源问题，两篇合并到 WP-F 一处实现**，别各做一套。
> 下文 P0/P1/P2 保留作 depth 参考，**实际开工以集成文档 WP-F 为准**。

## 判断

Shell 能力已经从单次命令执行，变成 coding agent 的运行控制面。真正的领先形态包含六件事：命令级权限、PTY 与非 PTY 分层、后台任务监控、完整输出回读、用户接管、失败恢复。

Neo 当前的底层执行能力已经比较完整。`Bash` 支持前台命令、PTY、后台任务、实时输出、超时和 kill；`Process` 支持 list、poll、log、write、submit、kill、output；权限分类和危险命令硬拦截也已经存在。下一步最值得做的不是重写 shell runner，而是把这些能力整理成稳定产品契约，让用户和 agent 都知道什么能自动跑、什么必须问、长任务在哪里看、截断输出怎么找回、重启以后任务是什么状态。

这条线的优先级应该高。Shell 是工程 agent 最容易出事故、也最能建立信任的能力面。一旦处理好，Neo 在真实 repo 里的可托付程度会明显提升。

## 目标形态

目标是把 Neo 的 Shell / Terminal / Background Monitor 做成四层能力。

第一层是命令执行面。非 PTY 用于测试、构建、格式化、搜索、git 状态这类确定性命令；PTY 用于 REPL、dev server、交互安装、登录流程、需要 stdin 的命令；后台任务用于长跑服务、watch、benchmark、迁移脚本、集成测试。

第二层是权限策略面。用户能用可读规则表达允许和拒绝，例如 `Bash(git status)`、`Bash(npm run test:*)`、`Bash(curl:docs.*)`。策略需要支持 user/project 两层配置、deny 优先、命中原因可见、危险命令硬拦截兜底。观察类动作和控制类动作要分开，查看进程状态不应等同于执行命令。

第三层是观察与恢复面。任何 shell session 都有稳定 id、cwd、命令、pid/process group、start time、status、exit code、output file、last output tail。输出被截断时，agent 必须拿到确定性回读入口。应用重启以后，Neo 要能区分仍在运行、已退出但日志可读、已失败、已被系统清理。

第四层是用户接管面。用户可以打开或聚焦一个真实 terminal，接管 PTY session。接管期间 agent 停止写入，只保留 poll/log；用户释放后 agent 再恢复操作。Background Monitor 需要让用户看到所有 shell/PTY/background 任务，并能 kill、retry、open log、回到 owner session。

## Neo 当前状态

Neo 已经有一套可继续演进的实现基础。

`Bash` schema 已经暴露 `timeout`、`working_directory`、`run_in_background`、`pty`、`wait_for_completion`、cols、rows。执行层里已经有前台命令、PTY session、后台任务、实时输出 delta、长输出归档、超时处理、进程组清理和失败提示。

后台任务管理器已经支持最多 10 个任务、1MB 内存输出、10 分钟运行时限、输出文件、SIGTERM/SIGKILL 清理、任务列表和 task output。PTY executor 也有 session 管理、stdin 写入、submit、resize、kill、poll、log 文件读取。

`Process` 工具已经把 list、poll、log、write、submit、kill、output 放到统一入口，方向是对的。它已经能把后台任务和 PTY session 放在同一张进程视图里。

权限层已有两条线：`permissionClassifier.ts` 用规则识别只读命令、危险命令和需要询问的命令；`commandPolicy.ts` 对 curl pipe shell、反弹 shell、sudo、危险 rm、dd device 等模式做硬拦截。这能防住一批高风险命令。

主要缺口也很清楚。

命令权限还偏启发式，缺少用户可配置的命令级 DSL。`Process` 目前统一是 execute 权限，导致 list/poll/log 这种观察动作和 write/submit/kill 这种控制动作混在一起。后台任务和 PTY 有持久化记录，但重启加载时 running session 会直接标 failed，还不能恢复 live process。截断输出有归档，但回读入口还不够确定，尤其是后台任务超过 memory buffer 后应该直接支持 file tail/offset。用户接管还停留在工具协议层，缺少真实 terminal handoff 和 agent 暂停写入状态。

## 长期路线

### P0

P0 目标是让现有 shell 能力从“能跑”变成“可控、可看、可恢复”。

1. 命令级权限 DSL
   - 新增 project/user 两层 shell permission 配置。
   - 支持 `Bash(command)`、prefix、glob、参数维度匹配，例如 `Bash(git status)`、`Bash(npm run test:*)`、`Bash(curl:docs.*)`。
   - deny 优先，危险命令硬拦截优先级最高。
   - 每次权限决策返回命中规则、来源、风险说明和下一步动作。
   - 保留当前 `permissionClassifier.ts` 的快速规则，把 DSL 命中放在 LLM fallback 之前。

2. Process 读写权限拆分
   - 把 `Process list/poll/log/output` 标成观察类动作。
   - 把 `Process write/submit/kill` 标成控制类动作。
   - `task_output` 默认按读类处理；`kill_shell` 继续按控制类处理。
   - 工具返回中明确 action class，方便 UI 和审计展示。

3. 确定性输出回读
   - 所有 Bash、PTY、background 输出都返回稳定 output ref。
   - 截断时必须给出可执行的回读方式：tool name、session/task id、tail/offset、output file。
   - `Process log` 对 background task 直接读取 output file，支持 tail、offset、limit。
   - 保留 memory buffer 作为快速预览，不把它当完整日志来源。

4. 后台任务恢复
   - 持久化 pid、process group、cwd、command、output file、startedAt、owner session、runner type。
   - 应用重启后检查 pid 是否存活。
   - 状态拆成 `running-recovered`、`dead-log-only`、`failed`、`killed`。
   - 对无法确认的任务保留 log-only 入口，不直接把证据丢掉。

5. 长任务监控契约
   - 后台任务启动后返回 monitor card 所需字段：id、command、cwd、status、startedAt、last tail、output ref、kill action。
   - 约定 poll cadence，长时间无输出时给 heartbeat。
   - 前台 timeout 的错误建议直接指向 background 或 PTY 重跑。

### P1

P1 目标是把 shell 能力做成用户可理解的产品面。

1. Run mode
   - 增加 Ask、Auto-review、Sandboxed、Bypass 四类运行模式。
   - Ask 默认询问敏感命令。
   - Auto-review 使用命令级 DSL、规则分类和危险命令硬拦截。
   - Sandboxed 把 OS sandbox 变成显式模式，限制文件和网络边界。
   - Bypass 只在用户明确开启时使用，并持续显示风险状态。

2. 用户接管
   - PTY session 支持 open/focus 到真实 terminal。
   - 用户接管后标记 `user_controlled`。
   - `user_controlled` 期间 agent 禁止 write/submit，只允许 poll/log。
   - 用户释放控制权或命令退出后，agent 才能继续操作。

3. Background Monitor
   - 做统一 monitor 视图，展示 shell background、PTY、scheduled jobs。
   - 字段包含 owner session、cwd、command、status、duration、last output tail、exit code、output ref。
   - 支持 kill、retry、open log、jump to session。
   - 对失败任务提供恢复建议，而不是只显示 exit code。

4. 失败恢复 recipe
   - timeout：建议转后台或 PTY。
   - permission denied：展示被哪条规则拦住，以及用户如何临时批准。
   - command not found：建议检查 PATH、package script、workspace dependency。
   - long no output：建议 poll、tail log、kill 或继续等待。
   - non-zero exit：保留 stdout/stderr、cwd、命令和重试入口。

### P2

P2 目标是把 shell 变成跨会话、跨窗口、可审计的运行系统。

1. Shell session ledger
   - 所有 shell/PTY/background run 进入统一 ledger。
   - 支持按 repo、session、task type、status、command 搜索。
   - 重要命令保留审计记录：谁触发、权限如何通过、输出摘要、最终状态。

2. Policy UI
   - 用户可以在设置里管理 shell allow/deny 规则。
   - 每条规则显示命中次数、最近命令、最近拒绝原因。
   - 支持从审批弹窗一键生成规则。

3. Sandbox profile
   - 支持 workspace-write、read-only、network-off、network-allowlist 等 profile。
   - 命令级规则可以绑定 sandbox profile。
   - 对包管理器、curl、ssh、docker、git push 这类高风险命令给默认 profile。

4. Prompt compatibility
   - 注入 `NEO_AGENT=1`、`TERM`、简化 prompt 标记。
   - 文档提示用户在 agent terminal 里关闭重 prompt、主题插件和会污染输出的 shell init。
   - 对 Powerlevel、starship、conda auto activate 这类常见输出污染做兼容建议。

### Later

Later 目标是把 monitor 从“工具面”升级成“工程运行面”。

1. Remote shell support
   - 为 SSH、container、devbox、CI runner 建立同一套 process contract。
   - 输出、权限、kill、log、恢复都复用 Background Monitor。

2. Multi-agent coordination
   - 多个 agent 共享同一 repo 时，Background Monitor 能显示 owner agent 和冲突风险。
   - 对同一 cwd 的长任务、dev server、test watch 做占用提醒。

3. Automated remediation
   - 对已知失败模式自动生成修复分支或 retry plan。
   - 失败恢复仍需经过权限策略，不允许绕开 command policy。

## 关键实现区域

- `src/main/tools/modules/shell/bash.schema.ts`
- `src/main/tools/modules/shell/bash.ts`
- `src/main/tools/modules/shell/process.schema.ts`
- `src/main/tools/modules/shell/process.ts`
- `src/main/tools/modules/shell/taskOutput.ts`
- `src/main/tools/modules/shell/killShell.ts`
- `src/main/tools/modules/shell/commandPolicy.ts`
- `src/main/tools/shell/backgroundTasks.ts`
- `src/main/tools/shell/ptyExecutor.ts`
- `src/main/tools/shell/platformShell.ts`
- `src/main/tools/permissionClassifier.ts`
- `src/main/tasks/backgroundTaskSnapshotAdapters.ts`
- `src/main/tasks/backgroundTaskStore.ts`
- `src/main/prompts/tools/bash.ts`
- `docs/guides/tools-reference.md`
- `docs/architecture/tool-system.md`
- `tests/unit/tools/modules/shell/bash.test.ts`
- `tests/unit/tools/modules/shell/process.test.ts`
- `tests/unit/tools/modules/shell/taskOutput.test.ts`
- `tests/unit/tools/permissionClassifier.test.ts`
- `tests/unit/tasks/backgroundTaskSnapshotAdapters.test.ts`
- `tests/security/commandSafety.test.ts`

## 验收标准

P0 验收：

- 用户可以配置命令级 allow/deny，至少覆盖 exact command、prefix、glob 三类匹配。
- `Bash(git status)` 这类安全命令可自动通过，`Bash(rm -rf /)` 这类危险命令被硬拒绝，拒绝原因可见。
- `Process list/poll/log/output` 不再触发执行类审批；`Process write/submit/kill` 仍走控制类审批。
- 前台 Bash、PTY、background 三种输出在截断时都返回确定性回读入口。
- background output 超过内存 buffer 后，仍能通过 `Process log` 从文件按 tail/offset 读取。
- 应用重启后，仍在运行的后台任务能恢复为 `running-recovered`；已退出任务保留 `dead-log-only` 和 log。
- 长任务 timeout 的错误返回包含可执行恢复建议。
- 相关单测覆盖权限 DSL、Process 权限拆分、输出回读、后台恢复、危险命令拦截。

P1 验收：

- Run mode 在设置和执行链路里可见，Ask、Auto-review、Sandboxed、Bypass 行为可测。
- Sandboxed 模式下，命令的文件和网络边界能被验证。
- PTY session 可以进入 `user_controlled` 状态，agent 在该状态下不能 write/submit。
- Background Monitor 展示 shell background、PTY、scheduled jobs，并支持 kill、retry、open log、jump to session。
- 常见失败类型能给出具体 recovery recipe。

P2 验收：

- shell session ledger 能按 repo、session、status、command 查询。
- 审计记录能还原命令、权限命中、输出摘要和最终状态。
- Policy UI 支持从审批结果创建 allow/deny 规则。
- Sandbox profile 可以绑定到命令规则。

## 风险与未决问题

- 命令级 DSL 需要避免过度复杂。第一版只支持 exact、prefix、glob 和少量参数语义，不急着做完整 shell parser。
- sandbox 的跨平台语义会不一致。macOS、Linux、Windows 需要分层实现，文档里也要把能力差异讲清楚。
- 重启恢复不能误杀用户进程。恢复时只应该管理 Neo 自己创建、且能匹配 pid/process group/output ref 的任务。
- 用户接管需要清晰状态机。agent 不能在用户正在输入时抢写 stdin，也不能因为没有输出就误判卡死。
- Background Monitor 容易膨胀成任务中心。P1 只收 shell/PTY/scheduled jobs，先不扩到所有 agent 工作流。
- 权限规则和危险命令硬拦截可能冲突。硬拦截优先级必须最高，用户 allow 也不能覆盖 fork bomb、反弹 shell、危险 root 删除这类规则。
- 输出日志可能包含 secret。log 回读和 ledger 需要考虑脱敏、权限和保留周期。

## 证据来源

本地证据：

- `src/main/tools/modules/shell/bash.schema.ts`
- `src/main/tools/modules/shell/bash.ts`
- `src/main/tools/shell/backgroundTasks.ts`
- `src/main/tools/shell/ptyExecutor.ts`
- `src/main/tools/modules/shell/process.schema.ts`
- `src/main/tools/modules/shell/process.ts`
- `src/main/tools/modules/shell/taskOutput.ts`
- `src/main/tools/modules/shell/killShell.ts`
- `src/main/tools/modules/shell/commandPolicy.ts`
- `src/main/tools/permissionClassifier.ts`
- `src/main/tasks/backgroundTaskSnapshotAdapters.ts`
- `src/main/tasks/backgroundTaskStore.ts`
- `docs/guides/tools-reference.md`
- `docs/architecture/tool-system.md`
- `tests/unit/tools/modules/shell/bash.test.ts`
- `tests/unit/tools/modules/shell/process.test.ts`
- `tests/unit/tools/modules/shell/taskOutput.test.ts`
- `tests/unit/tools/permissionClassifier.test.ts`
- `tests/unit/tasks/backgroundTaskSnapshotAdapters.test.ts`
- `tests/security/commandSafety.test.ts`

外部官方证据：

- Claude Code settings、CLI reference、hooks 文档：命令级权限、approval mode、hook approval。
- Cursor Terminal、Security、CLI permissions、CLI using 文档：native terminal、run mode、sandbox、`Shell(...)` 权限 pattern、history/resume/cloud handoff。
- Devin 官方 docs：持久 session、workspace/shell/browser/planner 的可观察协作模式。
- OpenCode 官方源码：terminal-first agent 的 shell tool、permission、session 组织方式。
- Gemini CLI 官方源码：shell execution、approval、sandbox/workspace 边界。
- OpenAI Codex 官方源码：shell execution、sandbox、approval policy、workspace boundary。
