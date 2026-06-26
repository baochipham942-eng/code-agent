# Edit / Patch / Checkpoint 长期方案

> 🔗 **集成修订（2026-06-26 审计回写）** — 统一排期与证据契约见 [`2026-06-26-00-INTEGRATION-evidence-and-resequencing.md`](./2026-06-26-00-INTEGRATION-evidence-and-resequencing.md)。本篇与 **primitive-tool-design + codebase-navigation 的 read 规则合并为 WP-B「Primitive 证据链」**，推荐优先级 **3**。要点：
> - 与上述两篇 P0 改同一批文件，**必须合一个工作包推进**，分开做必冲突。
> - "变更账本"（changedFiles/diffId/checkpointId）改为消费统一 `EvidenceRef`（diff/patch 各一条 ref，checkpointId 进领域字段，见 WP-A），不自立证据结构。
> - ✅ Write 覆盖既有文件无 pre-read gate 已核实，归 WP-B P0；checkpoint canonical path / fail-closed / rollback 冲突检测均保留。
> 下文 P0/P1/P2 保留作 depth 参考，**实际开工以集成文档 WP-B 为准**。

## 判断

Edit / Patch / Checkpoint 的长期方向，是把文件修改从“工具能写入”升级成“用户可信任的改动账本”。模型每次准备改文件前，系统要能回答四个问题：

- 这个文件是否已经被当前 agent 读过，读完以后有没有被外部改过。
- 这次改动会影响什么路径、什么 hunk、什么权限边界。
- 如果改动失败，失败原因是否能指导模型下一步修正。
- 如果用户撤回，系统是否能恢复文件和会话，同时保护用户在 agent 之后手动写入的内容。

Neo 当前已经有基础，但还没有形成强产品承诺。`Edit` 的 read-before-edit、外部修改检测、原子写、模糊替换护栏、checkpoint、turn diff 和 Undo 都已经存在；短板集中在 `Write` 覆盖保护、checkpoint 的路径一致性和失败策略、权威 diff preview、rollback 冲突检测、native Patch 以及大文件/dirty worktree 的安全网。

长期方案不应该先追完整环境级 time travel。第一优先级是把普通 coding agent 最常见的文本文件改动做可靠：能预览、能解释、能撤回，且撤回时不覆盖用户后续手动修改。

## 目标形态

目标形态是三层能力合在一条链路里。

第一层是编辑前置条件。`Edit` 和覆盖既有文件的 `Write` 都要经过同一套安全判断：目标路径解析一致，文件已读，读后未被外部修改，权限边界可解释。新建文件可以低摩擦，但覆盖既有文件必须更严格。

第二层是结构化变更。Neo 需要保留 `Edit` 做精确替换，保留 `Write` 做新文件和完整产物，同时增加 native `Patch` 做多文件、多 hunk、可 dry-run 的结构化修改。模型不应该只能在“多次 Edit”和“整文件 Write”之间摇摆。

第三层是 checkpoint 和撤回。每次写入前保存权威 preimage，写入后记录实际 postimage 或 hash，UI diff 从 checkpoint 与落盘内容生成。用户可以按 turn 撤回，也可以进一步按文件或 hunk selective rollback。rollback 前再次检查当前文件状态，遇到外部修改时进入冲突状态，不能静默覆盖。

## Neo 当前状态

`Edit` 已经是当前最接近目标形态的部分。`src/main/prompts/tools/edit.ts` 明确要求先 `Read`，`src/main/tools/modules/file/multiEdit.ts` 运行时也强制 `fileReadTracker.hasBeenRead()`。同一模块还会在写入前调用 `checkExternalModification()`，并通过 `atomicWriteFile()` 落盘。失败码包括 `NOT_READ`、`EXTERNAL_MODIFIED`、`NOT_FOUND`、`AMBIGUOUS_MATCH` 等，已经具备让模型自我修正的基础。

模糊替换能力已经引入。`src/main/tools/utils/editReplacers.ts` 有 line-trim、block-anchor、indentation-flexible 三段 fallback，并针对嵌套块、纯锚点块、歧义过高场景做了 fail-closed 防护。相关测试在 `tests/unit/tools/editReplacers.test.ts`。

`Write` 当前更适合新建文件和完整产物。`src/main/tools/modules/file/write.ts` 有独占锁、父目录自动创建、原子写、代码完整性提示、大生成物阈值和 post-edit diagnostics。但覆盖已有文件时，只会报告 `Updated`，没有强制要求本轮已读，也没有调用外部修改检测。这是 P0 最大风险点。

checkpoint 链路已经接上工具执行。`src/main/tools/toolExecutor.ts` 在拿到 write isolation 后、真实执行前调用 `createFileCheckpointIfNeeded()`；`src/main/tools/middleware/fileCheckpointMiddleware.ts` 对 `Write`、`Append`、`Edit` 等写工具创建 checkpoint。`src/main/services/checkpoint/fileCheckpointService.ts` 会保存原内容或文件不存在状态，并支持按 message rewind。

checkpoint 当前是 fail-open。middleware 捕获异常后只记日志，不阻断工具执行；service 默认跳过 1MB 以上文件。这个策略对新建小文件可以接受，但对覆盖既有文件不够可靠。

UI 已经有撤回入口。`src/renderer/components/features/chat/MessageBubble/TurnDiffSummary.tsx` 会聚合 turn 内的 `Edit`/`Write` 变化并提供 Undo；`src/main/app/agentAppService.ts` 的 prompt rewind 会找用户消息之后第一个 checkpoint，先 rewind files，再隐藏后续消息。当前 diff 更多来自工具参数和结果，不是完全权威的 checkpoint preimage/postimage。

## 长期路线

### P0

1. 覆盖既有文件的 `Write` 加 pre-read gate。
   - 任务：在 `src/main/tools/modules/file/write.ts` 中判断目标已存在时，默认要求 `fileReadTracker.hasBeenRead(resolvedPath)`。
   - 任务：复用 `checkExternalModification(resolvedPath)`，读后被改则返回 `EXTERNAL_MODIFIED`。
   - 任务：保留 `force` 作为逃生口，但必须走权限强确认，并在结果里标记 `forcedOverwrite: true`。
   - 测试：补 `tests/unit/tools/modules/file/write.test.ts`，覆盖未读覆盖、已读覆盖、外部修改、force 覆盖四类。

2. checkpoint 使用 canonical path。
   - 任务：把 checkpoint 创建从 raw `params.file_path` 改为工具执行前可复用的 resolved path 逻辑，至少覆盖相对路径、绝对路径、`~`、eval sandbox remap、workspace 外路径。
   - 任务：给 `createFileCheckpointIfNeeded()` 增加 resolved path 输入，避免 checkpoint 存的路径和工具实际写的路径不一致。
   - 测试：新增 checkpoint path mismatch 回归，证明 checkpoint 和实际写入文件是同一个 canonical path。

3. 覆盖写入 checkpoint fail-closed。
   - 任务：checkpoint service 返回结构化状态：`created`、`skipped_new_file`、`skipped_large_file`、`failed`。
   - 任务：既有文件写入前 checkpoint 失败时阻断写入；新建文件 checkpoint 跳过可以继续，但 tool result 和 execution ledger 要记录。
   - 任务：大文件跳过时返回 `CHECKPOINT_SKIPPED_LARGE_FILE`，提醒模型和用户当前 Undo 不完整。
   - 测试：补 executor/middleware 测试，覆盖 checkpoint 失败阻断既有文件覆盖。

4. 权威 diff preview。
   - 任务：在 checkpoint service 或独立 diff service 中，从 checkpoint original content 与当前落盘内容生成 unified diff。
   - 任务：TurnDiffSummary 优先使用 checkpoint diff；缺 checkpoint 时再 fallback 到 tool args。
   - 任务：permission preview 和 Undo preview 使用同一份 diff 数据，避免 UI 展示和实际撤回不一致。
   - 测试：补 renderer utils 和 IPC 测试，覆盖 Write 参数被截断时仍能展示真实 diff。

5. rollback 冲突检测。
   - 任务：checkpoint 创建时记录 `mtimeMs`、`size`、可选 content hash。
   - 任务：rewind 前读取当前文件状态，如果 checkpoint 之后又被外部修改，返回 `ROLLBACK_CONFLICT`。
   - 任务：UI 展示冲突文件，先不做强制覆盖入口，P0 只要 fail-closed。
   - 测试：补 `FileCheckpointService.rewindFiles` 测试，证明外部修改时不覆盖当前文件。

6. 失败解释标准化。
   - 任务：统一 `NOT_READ`、`EXTERNAL_MODIFIED`、`AMBIGUOUS_MATCH`、`CHECKPOINT_FAILED`、`CHECKPOINT_SKIPPED_LARGE_FILE`、`ROLLBACK_CONFLICT` 的文案。
   - 任务：每个错误都包含下一步动作，例如 re-read、增加上下文、使用 Patch、请求用户确认。
   - 测试：补工具返回值快照或 focused assertions。

### P1

1. native `Patch` 工具。
   - 任务：新增 `src/main/tools/modules/file/patch.ts` 和 schema，支持 `dry_run`、`apply`、`reverse_preview`。
   - 任务：patch 格式采用结构化 add/update/delete file，不让模型输出任意 shell patch。
   - 任务：apply 前复用 read-before-write、external modification、checkpoint、write isolation。
   - 任务：patch 失败返回 hunk 定位和最近上下文，指导模型重试。
   - 测试：覆盖 add file、update hunk、delete file、hunk 不匹配、dry-run 不落盘。

2. `Edit`、`Write`、`Patch` 统一变更账本。
   - 任务：工具执行结果统一记录 `changedFiles`、`diffId`、`checkpointId`、`canUndo`。
   - 任务：tool execution ledger 记录 begin/complete 时带上 diff/checkpoint 元数据。
   - 任务：UI 的 turn diff、permission preview、Undo 都从账本读。

3. selective rollback。
   - 任务：checkpoint preview 返回文件级 diff，而不是只有文件列表。
   - 任务：支持按文件撤回；hunk 级撤回作为 P1 后半段，依赖 native Patch。
   - 任务：撤回后刷新 read tracker，避免下一次 Edit 基于旧 mtime。
   - 测试：覆盖单 turn 多文件，只撤回其中一个文件。

4. prompt rewind 和 file rewind 对齐。
   - 任务：prompt rewind 使用同一套 rollback conflict 检测和 diff preview。
   - 任务：文件 rewind 失败时继续保持当前策略，不隐藏消息。
   - 测试：扩展 `tests/unit/app/agentAppService.lifecycle.test.ts`。

### P2

1. 大文件 checkpoint。
   - 任务：小文件继续存全文，大文件改为存 hash、size、mtime 和 patch。
   - 任务：如果大文件 patch 不可安全生成，写入前要求强确认，并明确 Undo 不完整。
   - 任务：支持配置 checkpoint 大小阈值。
   - 测试：覆盖超过 1MB 文件的 patch checkpoint、不可生成 patch 的阻断或降级。

2. git safety net。
   - 任务：在 git repo 内识别 dirty worktree，区分 agent 改动和用户已有改动。
   - 任务：每轮 agent 改动可导出 patch 到本地安全目录。
   - 任务：提供 apply/reverse apply 验证命令和 UI 入口。
   - 任务：复用 `src/main/services/checkpoint/taskPatchService.ts` 的 patch 捕获经验，但不要把任务取消 patch 和常规工具 checkpoint 混成同一职责。

3. checkpoint 审计视图。
   - 任务：在开发/诊断面展示每个 turn 的 checkpoint 状态、diff 状态、rollback 可用性。
   - 任务：对 `CHECKPOINT_SKIPPED_*` 和 `ROLLBACK_CONFLICT` 做可搜索事件。

### Later

1. 环境级 time travel。
   - 在文本文件链路稳定后，再评估是否需要数据库、依赖安装、生成产物目录、dev server 状态的环境级 checkpoint。

2. 多 agent 并发改动回放。
   - 结合 write isolation 和 execution ledger，把并发子 agent 的写入按因果顺序回放或撤回。

3. Patch repair agent。
   - 当 patch hunk 失败时，启动轻量 repair path 重新定位上下文，限制在当前文件和当前 hunk 范围内。

## 关键实现区域

- `src/main/prompts/tools/edit.ts`：Edit prompt 的 read-before-edit 和失败修正指引。
- `src/main/prompts/tools/fileWrite.ts`：Write / Append / Edit 的选择规则，需要加入覆盖既有文件的 pre-read 约束。
- `src/main/tools/modules/file/write.ts`：Write 覆盖保护、external modification 检测、force overwrite 元数据。
- `src/main/tools/modules/file/write.schema.ts`：Write 参数和 force 语义。
- `src/main/tools/modules/file/multiEdit.ts`：Edit 的 read-before-edit、external modification、atomic write、diagnostics。
- `src/main/tools/utils/editReplacers.ts`：fuzzy replace fallback 和 fail-closed 护栏。
- `src/main/tools/utils/externalModificationDetector.ts`：读后外部修改检测，后续可扩展 hash。
- `src/main/tools/fileReadTracker.ts`：读记录、编辑后 mtime/size 更新、rollback 后刷新。
- `src/main/tools/middleware/fileCheckpointMiddleware.ts`：checkpoint 创建策略、canonical path、fail-closed。
- `src/main/services/checkpoint/fileCheckpointService.ts`：checkpoint 存储、rewind、preview、冲突检测、大文件策略。
- `src/main/ipc/checkpoint.ipc.ts`：checkpoint list/preview/rewind/fork IPC。
- `src/main/tools/toolExecutor.ts`：checkpoint 调用点、write isolation、execution ledger、权限确认 preview。
- `src/main/tools/permissionClassifier.ts`：写入项目内外的权限分类和强确认策略。
- `src/main/security/writeIsolation.ts`：并发写隔离。
- `src/renderer/components/features/chat/MessageBubble/TurnDiffSummary.tsx`：turn diff、Undo、后续 selective rollback UI。
- `src/renderer/utils/turnDiffSummary.ts`：当前基于 tool args 的 diff 聚合，后续需要优先使用 checkpoint diff。
- `src/main/app/agentAppService.ts`：prompt rewind 的文件回滚和消息隐藏顺序。
- `tests/unit/tools/modules/file/write.test.ts`：Write 行为回归。
- `tests/unit/tools/editReplacers.test.ts`：fuzzy replacer 回归。
- `tests/unit/tools/enhancements/externalModificationDetector.test.ts`：外部修改检测回归。
- `tests/unit/app/agentAppService.lifecycle.test.ts`：prompt rewind 回归。
- `tests/renderer/utils/turnDiffSummary.test.ts`：diff 聚合回归。

## 验收标准

P0 验收：

- 覆盖已有文件的 `Write` 在未 Read 时失败，并提示先 Read。
- 覆盖已有文件的 `Write` 在读后被外部修改时失败，并提示重新读取。
- `force` 覆盖会留下明确元数据和权限确认，不会伪装成普通安全写入。
- checkpoint 存储路径与实际写入路径一致，eval sandbox 场景不能污染真仓，也不能把 checkpoint 存到真仓路径。
- 既有文件写入前 checkpoint 失败时，工具不落盘。
- TurnDiffSummary 展示的 diff 来自 checkpoint preimage 和实际落盘内容。
- rollback 前检测外部修改，冲突时不覆盖当前文件。
- prompt rewind 在文件 rewind 失败时不隐藏消息。
- 相关测试通过：`write.test.ts`、`externalModificationDetector.test.ts`、checkpoint service focused tests、`agentAppService.lifecycle.test.ts`、`turnDiffSummary.test.ts`。

P1 验收：

- `Patch` 工具支持 dry-run 和 apply，能处理 add/update/delete file。
- patch hunk 失败时返回文件、hunk、原因和下一步建议。
- 同一 turn 多文件改动可以只撤回其中一个文件。
- Undo preview、permission preview、tool result summary 使用同一份 diff 数据。
- execution ledger 能追到 `checkpointId`、`diffId`、`changedFiles`。

P2 验收：

- 超过默认 1MB 的文件不再只有跳过策略，至少能记录 hash + patch 或明确阻断。
- git repo 内能导出 agent patch，并能在干净 clone 上 `git apply`。
- dirty worktree 能区分用户已有改动和 agent 本轮改动。

## 风险与未决问题

- checkpoint fail-closed 会增加写入失败率，尤其是生成类任务。P0 需要区分新建文件、覆盖既有文件和大文件，不能一刀切阻断所有写入。
- `Write` 增加 pre-read 后，模型可能多一次 Read 调用。需要通过 prompt 和失败文案让模型知道什么时候该用 `Edit`，什么时候该用 `Patch`。
- canonical path 必须和工具内部 path resolver 保持一致。若每个工具各自解析路径，checkpoint 仍可能漂移，最好抽共享 helper。
- 大文件 checkpoint 的 patch 策略依赖原始内容可读和 diff 可计算。二进制文件、压缩文件、Office 文件需要另走 artifact/office skill 的版本策略。
- rollback 冲突处理的 UI 复杂度不能一次做满。P0 只做 fail-closed 和解释，P1 再做选择保留或强制覆盖。
- native Patch 的格式要足够严格，避免变成 shell `patch` 的包装层。安全边界、dry-run 和错误定位比兼容任意 patch 语法更重要。
- git safety net 不能替代 Neo 自己的 checkpoint。用户可能在无 git 仓库、dirty 仓库、浅 clone、submodule 或 worktree 中工作。
- selective rollback 会带来“会话说已完成但文件部分撤回”的状态不一致，需要在 trace 和消息上显示撤回记录。

## 证据来源

本地证据：

- `src/main/prompts/tools/edit.ts`：Edit prompt 已要求先 Read，多 edit 失败整体回滚。
- `src/main/prompts/tools/fileWrite.ts`：Write 用于新文件或完整重写，精确修改建议走 Edit after Read。
- `src/main/tools/modules/file/multiEdit.ts`：Edit 强制 Read、检测外部修改、原子写、返回结构化失败码。
- `src/main/tools/modules/file/write.ts`：Write 有原子写和完整性提示，但覆盖既有文件没有 Read 前置条件。
- `src/main/tools/utils/editReplacers.ts`：多级 fuzzy replacer 和 fail-closed 护栏。
- `src/main/tools/utils/externalModificationDetector.ts`：基于 read tracker 的 mtime/size 外部修改检测。
- `src/main/tools/toolExecutor.ts`：checkpoint 在 write isolation 后、工具执行前创建。
- `src/main/tools/middleware/fileCheckpointMiddleware.ts`：checkpoint 失败当前 fail-open。
- `src/main/services/checkpoint/fileCheckpointService.ts`：checkpoint 保存原内容或文件不存在状态，支持 message rewind，默认 1MB 阈值。
- `src/main/ipc/checkpoint.ipc.ts`：checkpoint list/preview/rewind/fork IPC。
- `src/main/app/agentAppService.ts`：prompt rewind 先回滚文件，再隐藏消息。
- `src/renderer/components/features/chat/MessageBubble/TurnDiffSummary.tsx`：turn diff 和 Undo 入口。
- `tests/unit/tools/editReplacers.test.ts`：fuzzy replacer 正负例。
- `tests/unit/tools/enhancements/externalModificationDetector.test.ts`：外部修改检测测试。
- `tests/unit/tools/modules/file/write.test.ts`：Write 创建、覆盖、完整性提示、大文件阈值测试。
- `tests/unit/app/agentAppService.lifecycle.test.ts`：prompt rewind 的文件回滚和失败保护测试。

外部证据：

- Claude Code checkpointing：prompt 和文件编辑前自动 checkpoint，restore 可选择 code、conversation 或 both，外部手动修改不纳入 checkpoint。
- Anthropic text editor tool：`str_replace` 要求唯一精确匹配，`create` 不覆盖已有文件。
- Replit checkpoints and rollbacks：Agent 改动后生成 checkpoint，支持 preview 和 rollback。
- OpenCode tools 和 undo：`patch` 工具用于结构化文件修改，`/undo` 撤回上一条用户消息造成的变更。
- OpenAI Codex apply_patch：结构化 add/update/delete file patch 协议。
- Aider git integration 和 edit formats：自动 commit、dirty changes 分离、`/diff`、`/undo`、whole/diff/search-replace 编辑格式。
