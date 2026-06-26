# Primitive Tool Design 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇与 **edit-patch-checkpoint + codebase-navigation 的 read 规则合并为 WP-B「Primitive 证据链」**，推荐优先级 **3**。要点：
> - 三篇 P0 改同一批文件（`read.ts`/`write.ts`/`multiEdit.ts`/`fileReadTracker.ts`/`glob.ts`/`listDirectory.ts`/`grep.ts`），**必须合一个工作包推进**，分开做必冲突。
> - Read 的 `evidenceToken` 改为统一 `EvidenceRef`（kind:'read' + digest，见 WP-A），不自立证据结构。
> - ✅ Write 覆盖既有文件无 pre-read gate（`write.ts` 确无 `hasBeenRead`/`checkExternalModification`），缺口真实，归 WP-B P0。
> 下文分层保留作 depth 参考，**实际开工以集成文档 WP-B 为准**。

## 判断

Coding agent 的基础工具正在从“命令包装器”变成“证据链系统”。Read、Grep、Glob、ListDirectory、Write/Edit、Bash 这些 primitive 不能只各自正确，它们必须共同保证三件事：

1. agent 看到的是可复核的当前证据。
2. agent 修改的是自己刚确认过的对象。
3. 大输出、长任务和失败信息不会污染上下文，也不会丢掉关键错误线索。

Neo 当前已经有不少扎实基础：Read 有行号和 offset/limit，Edit 有 read-before-edit 和外部修改检测，Bash 有 PTY/background/output spill，tool result budget 能保留错误关键行。主要缺口不在工具数量，而在工具之间的契约还不够硬：搜索结果还不能自动约束后续编辑，Write 覆盖已有文件不要求最新 Read，Glob/List 的分页排序弱，Bash 的边界更多靠事后防御而不是事前策略。

长期方向应该把 primitive tool 做成一个窄而硬的 workflow：Search/List 发现候选，Read 建立 evidence token，Edit/Write 消费 evidence token，Bash 主要负责验证和专用工具覆盖不到的执行场景，所有超大输出都进入可分页 archive。

## 目标形态

### Read

- 每次 Read 返回 line-numbered content，同时在 meta 和模型可见尾部提供 `evidenceToken`。
- `evidenceToken` 至少包含 `path`、`mtimeMs`、`size`、`sha256Prefix`、`totalLines`、`shownRange`、`binaryKind`。
- 大文件默认分页，不把整文件读入上下文；offset/limit 要稳定支持，并明确下一页起点。
- 二进制判断从扩展名拦截升级到内容 sniffing，保留 xlsx/docx/pdf/pptx 的专用工具引导。
- Read 结果成为后续 Edit/Write 的可验证前置条件，而不只是模型“看过文件”的隐式状态。

### Grep / Glob / ListDirectory

- Grep 保持 rg 优先和系统 grep fallback，继续支持 include/type/context/head_limit/offset。
- Glob 和 ListDirectory 都支持 `offset`、`limit`、`sort`，避免一次性把大目录或大匹配集塞进上下文。
- Glob 支持 `sort=mtime|path`，默认可以偏向最近修改文件；ListDirectory 支持目录优先和 path 排序。
- ignore 策略可显式配置：默认跳过 `node_modules`、`.git`、`dist`、`build`、`.next`、`coverage`，并提供 `respect_gitignore` 选项。
- 搜索类工具只产出候选证据，不直接满足编辑前置条件。每条命中应给出 next read hint。

### Write / Edit

- Edit/MultiEdit 必须消费最新 Read evidence token；现有 `force` 仍保留，但要带 reason 并进入审计。
- Write 创建新文件可以直接执行；Write 覆盖已有文件必须先 Read，或显式 `force`。
- 冲突检测从 `mtime + size` 升级到 `mtime + size + digest`，减少同尺寸改写漏判。
- 所有多步编辑保持 staged apply：任一 edit 找不到、歧义或冲突，整组不落盘。
- 高风险写入提供 diff preview artifact；已落盘写入提供 undo snapshot 或 patch id。
- post-edit feedback 形成阶梯：LSP diagnostics、formatter/linter、targeted test，由项目配置控制强度。

### Bash

- Bash 是通用执行口，不是文件读写首选入口。
- 系统提示、tool description 和 runtime guard 都要明确：能用 Read/Grep/Glob/List/Edit/Write 时，优先用专用工具。
- Bash 保留 cwd、timeout、env sanitize、PTY、background task、process polling、output spill。
- sandbox 从 bypassPermissions 专属能力，逐步提升为可配置安全边界：文件写入、网络域名、credential deny list 分开配置。
- 危险命令策略继续硬阻断，审批策略和 sandbox 策略要有统一解释口径，避免多层规则互相打架。

### Tool Output

- 每个大输出都先落 archive，再进入 head/tail/key-error-lines 截断。
- Bash foreground、PTY、background task、Grep、大目录 List 都要给出稳定 archive id 和分页读取提示。
- 错误输出保留 traceback、compiler error、test failure、exit code、cwd、command。
- archive hydration 只在模型明确需要原始证据时触发，防止旧大输出反复回流上下文。

## Neo 当前状态

### 已经较强

- `src/main/tools/modules/file/read.ts` 已有 offset/limit、6 位行号、长行截断、二进制格式重定向、`fileReadTracker.recordRead`。
- `src/main/tools/modules/file/multiEdit.ts` 已有 read-before-edit、外部修改检测、智能引号/柔性匹配、原子写、LSP diagnostics。
- `src/main/tools/modules/shell/bash.ts` 已有 PTY、background task、live output delta、timeout、cwd、sanitized env、output spill、tool confusion 防御。
- `src/main/tools/modules/shell/grep.ts` 已有 rg 优先、grep fallback、include/type/context、head_limit/offset 分页。
- `src/main/context/layers/toolResultBudget.ts` 已能截断 tool result，保留错误关键行，并 spill 到 archive。
- `src/main/tools/toolExecutor.ts` 已有 Bash security validation、policy enforcer、safe command、classifier/user approval 链路。

### 主要差距

- Read 的 freshness 信息只在内部 tracker 里，模型看不到稳定 evidence token。
- Read 记录只有 mtime/size，缺 digest；同尺寸改写或 mtime 精度问题仍可能漏判。
- Write 覆盖已有文件时没有 pre-read 要求，仍可能误覆盖用户或其他工具刚改过的文件。
- Glob 只有固定 ignore 和 200 条截断，没有分页、排序、`.gitignore` 选项。
- ListDirectory 正文没有分页上限，大目录仍可能污染上下文。
- Grep/Glob/List 的结果不会强制后续 Read，agent 可能凭搜索片段直接 Edit。
- Bash 的“少用于文件读写”主要靠 tool-confusion 检测，缺系统性 policy 和提示。
- post-edit feedback 主要是短等待 LSP，还没有 formatter/lint/test ladder。
- output archive 能力存在，但 Bash task/session、List/Grep 的 UX 提示还可以更统一。

## 长期路线

### P0

1. Read evidenceToken
   - 在 Read 成功结果里计算并返回 `evidenceToken`。
   - token 字段：`path`、`mtimeMs`、`size`、`sha256Prefix`、`totalLines`、`offset`、`limit`、`shownStartLine`、`shownEndLine`。
   - `fileReadTracker` 扩展保存 digest 和 shown range。
   - Read 输出尾部追加简短证据说明和下一页提示，避免模型猜 offset。

2. Write 覆盖 pre-read
   - Write 创建新文件不变。
   - Write 覆盖已有文件时，要求该路径存在最新 Read 记录。
   - 如果没有 Read，返回 `NOT_READ_FOR_OVERWRITE`，提示先 Read。
   - 如果 mtime/size/digest 不一致，返回 `STALE_FILE`，提示重新 Read。
   - `force: true` 必须带 `reason`，并写入 meta/audit。

3. Glob/List 分页排序
   - Glob schema 增加 `offset`、`limit`、`sort`、`respect_gitignore`。
   - ListDirectory schema 增加 `offset`、`limit`、`sort`，正文只输出当前页。
   - meta 保留 `totalMatches`/`totalEntries`、`returned`、`truncated`、`nextOffset`。
   - 默认排序：List 目录优先 + path；Glob 默认 path，可配置 mtime。

4. next read hint
   - Grep content 模式命中行时，输出建议 Read 区间。
   - Glob/List 输出文件路径时，输出简短提示：`Read(file_path, offset=1, limit=120)`。
   - hint 只做短文本，不膨胀 meta。

5. search-to-read guard
   - 运行时记录搜索工具产出的候选路径。
   - 对未 Read 但只在搜索中出现过的文件，Edit/MultiEdit/overwrite Write 返回 `READ_REQUIRED_AFTER_SEARCH`。
   - guard 错误要能告诉模型最近的候选路径和推荐 Read 参数。

6. tool output archive UX
   - Bash foreground 输出截断时明确给出 archive id 和 `read_tool_result_archive` 示例。
   - background task 和 PTY 输出文件也统一暴露 archive/readback 入口。
   - ListDirectory/Grep 超大输出也进入 archive，再输出当前页。

### P1

1. Bash 边界策略
   - 更新 Bash tool description：验证和项目命令优先，文件读写优先用专用工具。
   - 在 runtime 增加可解释 warning：当 Bash 命令是 `cat/head/tail/sed/grep/find/ls` 读文件时，优先建议对应 Read/Grep/List。
   - 对 Bash 写文件模式，如 heredoc、重定向、`python - <<EOF` 写文件，给出更明确的专用 Write/Edit 建议。
   - 梳理 commandPolicy、ToolExecutor permission、OS sandbox 三层输出文案，统一用户可理解的原因。

2. post-edit diagnostics/lint/test feedback
   - LSP diagnostics 增加可配置等待窗口和按文件语言过滤。
   - 增加项目级 `postEdit` 配置：formatter、linter、test command。
   - 默认只对被编辑文件跑轻量反馈；大测试必须用户或策略允许。
   - feedback 输出进入 tool result budget，保留关键错误行。

3. diff preview 与 undo snapshot
   - Write 覆盖、MultiEdit 多处修改、跨文件修改时生成 diff preview artifact。
   - toolExecutor 已有 checkpoint 入口时，补模型可见 snapshot id。
   - 提供 rollback/restore 工具或命令入口，至少支持最近一次文件修改。

4. docs 同步
   - 更新 `docs/guides/tools-reference.md`，把 Read/Edit/Write/Grep/Glob/List/Bash 的真实行为写准。
   - 更新 `docs/architecture/tool-system.md`，补 primitive evidence chain 和 output archive 设计。

### P2

1. sandbox 产品化
   - 将 Bash sandbox 从 bypassPermissions 档扩展为可配置模式。
   - 配置项区分 filesystem read/write、network domain、credential files/env vars。
   - sandbox 不可用时支持 strict failure 和 fallback approval 两种模式。

2. evidence-aware agent policy
   - 在 contextBuilder 或 runtime policy 中注入短规则：搜索后读、写前读、Bash 不替代专用工具。
   - 对连续 read-only loop 保持现有 hard limit，同时加“缺证据就说缺证据”的落地文案。
   - 对 stale edit 重试做次数限制，避免 read/edit/read/edit 循环。

3. large file streaming Read
   - Read 大文件时避免完整 `readFile('utf-8')` 后再 slice。
   - 以流式 line scanner 支持 offset/limit、binary sniff、line truncation。
   - 对 totalLines 可以先 unknown，必要时后台统计或按页返回 `nextOffset`。

### Later

1. 统一 file mutation transaction
   - 把 Write、Edit、MultiEdit、Append 统一到 transaction layer。
   - 每次 mutation 都有 evidence input、diff output、checkpoint、diagnostics、audit event。

2. 证据链可视化
   - 在 UI 或 trace 里展示：Search/List -> Read evidence -> Edit/Write -> Diagnostics/Test。
   - 用户能看懂 agent 为什么认为某个文件可以改。

3. tool planner hints
   - 基于 tool result meta 给模型更强的下一步建议，不靠长系统提示。
   - 例如 Grep 命中 1000 条时，建议缩小 include/type；Read 截断时建议下一页；Write stale 时建议重读范围。

## 关键实现区域

- `src/main/tools/modules/file/read.ts`
- `src/main/tools/modules/file/read.schema.ts`
- `src/main/tools/fileReadTracker.ts`
- `src/main/tools/utils/externalModificationDetector.ts`
- `src/main/tools/modules/file/write.ts`
- `src/main/tools/modules/file/write.schema.ts`
- `src/main/tools/modules/file/multiEdit.ts`
- `src/main/tools/modules/file/multiEdit.schema.ts`
- `src/main/tools/modules/file/glob.ts`
- `src/main/tools/modules/file/glob.schema.ts`
- `src/main/tools/modules/file/listDirectory.ts`
- `src/main/tools/modules/file/listDirectory.schema.ts`
- `src/main/tools/modules/shell/grep.ts`
- `src/main/tools/modules/shell/grep.schema.ts`
- `src/main/tools/modules/shell/bash.ts`
- `src/main/tools/modules/shell/bash.schema.ts`
- `src/main/tools/modules/shell/commandPolicy.ts`
- `src/main/tools/toolExecutor.ts`
- `src/main/agent/runtime/toolExecutionEngine.ts`
- `src/main/agent/runtime/toolPreflightGuards.ts`
- `src/main/agent/messageHandling/contextBuilder.ts`
- `src/main/context/layers/toolResultBudget.ts`
- `src/main/tools/modules/file/toolResultArchive.ts`
- `src/main/agent/runtime/contextAssembly/archiveHydration.ts`
- `src/main/tools/lsp/diagnosticsHelper.ts`
- `docs/guides/tools-reference.md`
- `docs/architecture/tool-system.md`
- `tests/unit/tools/modules/file/read.test.ts`
- `tests/unit/tools/modules/file`
- `tests/unit/tools/modules/shell`
- `tests/unit/context`

## 验收标准

### P0 验收

- Read 任意文本文件时，输出和 meta 都包含 evidence token，并能通过测试断言 token 字段。
- Edit/MultiEdit 在文件未 Read、Read 后外部修改、Read 后 digest 不一致三种场景都拒绝修改。
- Write 创建新文件仍可成功；Write 覆盖已有文件必须先 Read；force 覆盖必须带 reason。
- Glob/ListDirectory 支持 offset/limit，超出结果时返回 nextOffset；正文不超过当前页。
- Grep/Glob/List 输出包含 next read hint，且 hint 不显著增加大结果体积。
- 搜索命中的文件如果未 Read，直接 Edit/overwrite Write 会失败并提示 Read。
- Bash 大输出截断时，模型可见结果包含 archive id 和分页回查提示。
- 相关 unit tests 覆盖 Read、Write、MultiEdit、Glob、ListDirectory、Grep、Bash output archive。
- `docs/guides/tools-reference.md` 与真实工具行为一致。

### P1 验收

- Bash 读写文件的常见误用有可解释 warning 或 hard block，且不影响正常 test/build/git status 等命令。
- post-edit diagnostics 能对 TS/JS 文件返回 LSP 结果；配置 linter/test 后能把失败关键行回灌给 agent。
- 高风险 overwrite 和 multi-edit 产生 diff preview artifact。
- 最近一次文件修改可通过 checkpoint/snapshot 恢复，并有测试覆盖。
- `docs/architecture/tool-system.md` 写清 primitive evidence chain。

### P2 验收

- sandbox 能在配置开启后约束 Bash 子进程文件和网络访问。
- strict sandbox 模式下 sandbox 不可用会硬失败。
- large file Read 不再依赖整文件读入内存，并支持稳定分页。
- runtime policy 能减少 search 后直接 edit、Bash 替代专用工具、stale edit retry loop。

## 风险与未决问题

- evidence token 如果直接暴露完整 hash，可能增加输出噪音；建议只显示短 hash，完整值放 meta。
- digest 计算会增加大文件 Read 成本；P0 可先对已读取页和小文件计算，P2 再做流式完整 digest。
- Write 覆盖 pre-read 会改变现有 agent 行为，可能让部分“直接生成覆盖文件”的流程多一次 Read；需要明确创建新文件不受影响。
- search-to-read guard 可能误伤纯重命名、删除、生成类任务；需要只约束 Edit/MultiEdit 和 overwrite Write。
- Bash policy 如果太硬，会影响项目里临时脚本和 CLI 工作流；P1 应先 warning，再对明显文件读写误用 hard block。
- post-edit lint/test 可能引入耗时和副作用；必须由项目配置、权限和 timeout 控制。
- diff preview 与 checkpoint 需要和现有 toolExecutor checkpoint 关系理顺，避免重复快照和恢复语义不一致。
- `.gitignore` 策略在 Glob/List/Grep 中要统一，否则 agent 会因工具结果不一致而误判文件是否存在。

## 证据来源

本方案基于本线程已完成的 Primitive Tool Design brief、本仓源码阅读和官方资料对比，不再扩展新资料范围。

本地证据：

- `src/main/tools/modules/file/read.ts`
- `src/main/tools/modules/file/write.ts`
- `src/main/tools/modules/file/multiEdit.ts`
- `src/main/tools/modules/file/glob.ts`
- `src/main/tools/modules/file/listDirectory.ts`
- `src/main/tools/modules/shell/grep.ts`
- `src/main/tools/modules/shell/bash.ts`
- `src/main/tools/modules/shell/commandPolicy.ts`
- `src/main/tools/toolExecutor.ts`
- `src/main/agent/runtime/toolExecutionEngine.ts`
- `src/main/agent/runtime/toolPreflightGuards.ts`
- `src/main/agent/messageHandling/contextBuilder.ts`
- `src/main/context/layers/toolResultBudget.ts`
- `src/main/tools/modules/file/toolResultArchive.ts`
- `src/main/agent/runtime/contextAssembly/archiveHydration.ts`
- `src/main/tools/lsp/diagnosticsHelper.ts`
- `docs/guides/tools-reference.md`
- `docs/architecture/tool-system.md`

外部官方对比：

- Claude Code 官方 docs：Tools reference、Permissions、Sandboxed Bash。
- OpenAI Codex CLI 官方源码：shell spec、unified exec、apply_patch spec。
- Gemini CLI 官方源码：read-file、edit、grep、glob、ls、shell。
- Aider 官方源码与文档：SEARCH/REPLACE、chat files、lint/test feedback。
- OpenCode 官方源码：read/read-filesystem、edit、write、bash、glob、grep。
