# ADR-076：文件工具层的沙盒写边界

- 状态：**草稿·待爸拍板**
- 单号：N-SANDBOX-TOOLLAYER（knife 1）
- 基线：`origin/main@bd7e3ab597`
- 范围：Write、Edit 及后续文件写入工具；本刀不新增审批类型、不改 UI

## 决策摘要

文件工具的 Node 文件 IO 必须经过一个和 Bash 共用边界语义的入口
`resolveToolWriteTarget(path, ctx)`。入口返回 `allowed` 或带稳定原因的 `denied`；Write 和 Edit
先接入，NotebookEdit、SkillCreate、network/* 另列施工单。沙盒开关关闭时保持现有文件工具行为，
开关开启时越过 `readWriteRoots`、`deniedReadRoots` 或敏感路径均拒绝。

## 现状锚点

| 事实 | 代码锚点（已在本 ADR 基线复核） |
|---|---|
| OS 沙盒默认开启，只有 `OS_SANDBOX_ENABLED=false` 关闭 | `src/shared/constants/sandbox.ts:10-16` |
| 沙盒决策由 permission mode、write fence、eval root、multi-root 等输入决定 | `src/host/sandbox/osSandboxPolicy.ts:103-143` |
| `SandboxManager` 的命令写边界是 `readOnlyRoots`、`readWriteRoots`、`deniedReadRoots` | `src/host/sandbox/manager.ts:99-109` |
| 命令包装将 read/write/denied roots 传给 Seatbelt 或 Bubblewrap | `src/host/sandbox/manager.ts:339-385` |
| 既有 write-fence 原语和原因字符串 | `src/host/sandbox/writeFence.ts:38-42`、`:155-165` |
| 既有 shell 消费 write fence，并按 workspace scope 计算写根 | `src/host/tools/modules/shell/bash.ts:350-365`、`:446-464` |
| Write 原先直接对 `resolvedPath` 建目录并 atomic write | `src/host/tools/modules/file/write.ts:281-284`、`:444-448` |
| Edit 原先在 `filePath` 上取得锁并写回 | `src/host/tools/modules/file/multiEdit.ts:112-125`、`:220-224` |
| 敏感路径清单与目录/文件拒绝判断已有共用来源 | `src/host/sandbox/sensitivePaths.ts:67-78`、`:149-159` |
| 其他 Node writer 仍直接写文件 | `src/host/tools/modules/file/notebookEdit.ts:291-295`；`src/host/tools/modules/skill/skillCreate.ts:182-186`；`src/host/tools/modules/network/webSearch.ts:201-210`；`mermaidExport.ts:132-140`；`screenshotPage.ts:295-303`；`readXlsx.ts:345-350` |

## 威胁模型

提示词注入可以诱导模型调用 `Write` 或 `Edit`，传入绝对路径、相对路径穿越、已有目录下的
符号链接路径，或把生成物写到项目兄弟目录、主机配置和凭据目录。此前这些调用只经过工具
审批与文件并发/覆盖保护；Node 进程本身没有执行 Bash 的 Seatbelt/Bubblewrap mount 约束，
因此审批被自动允许、`dontAsk` 或等效无询问策略时，提示词注入仍能把文件写到进程可写的任意
位置。单靠审批不能表达「不问人但跑不出边界」。

## 设计

### 一个写入 seam

`resolveToolWriteTarget(path, ctx)` 位于 `src/host/sandbox/writeFence.ts`，是所有原生文件写入工具
的唯一写前检查。它复用现有 `containWriteFenceWorkspaceRoot`、`isOsSandboxEnabled`、敏感路径
清单和 `FENCED_IN_PROJECT_WRITE_REASON`，并按与 shell 相同的优先级确定根：

1. 有 `requiresOsWriteFence` 时，只允许已 containment 的 `writeFenceWorkspaceRoot`；
2. 有 `workspaceScope` 时，只允许其中 `access='read_write'` 的 roots；
3. 否则按 Bash 的单根规则使用 cwd，且 workspace 在 cwd 内时收紧为 workspace。

目标路径和根都做 canonical/现有父目录解析；符号链接不能绕过边界。`deniedReadRoots` 与
`getSensitiveSandboxPaths()` 一起作为不可写路径检查。返回 `denied(reason)` 时，Write/Edit 将
返回 `SANDBOX_WRITE_DENIED`，错误正文复用 `FENCED_IN_PROJECT_WRITE_REASON`，不引入新的
approval kind 或用户界面。

`OS_SANDBOX_ENABLED=false` 是现有紧急刹车，seam 在此情况下直接放行以保留旧行为；重新开启
后仍由本地 write fence 拒绝越界写。该开关与审批策略是两个轴，不能把审批通过解释成沙盒授权。

### Read 侧

本刀只收紧写入。`Read` 访问 `deniedReadRoots` 的明确拒绝码、错误文案和用户体验列为后续
产品/实现决策；写入口已经先把这些 roots 视为不可写，避免同一目录出现读禁而写通。

### 沙盒模式 × 审批策略矩阵

| OS 沙盒 | 审批策略 | 当前行为/目标 |
|---|---|---|
| 开启 | `ask` | Bash：already so；Write/Edit：this ADR |
| 开启 | `auto` / `acceptEdits` | Bash：already so；Write/Edit：this ADR |
| 开启 | `never` / `dontAsk` | Bash：already so；Write/Edit：this ADR；这是竞品 `workspace-write + never` 目标格 |
| 关闭（显式紧急刹车） | `ask` | 审批：already so；文件边界：Decision needed [产品口径] |
| 关闭（显式紧急刹车） | `auto` / `acceptEdits` | 审批：already so；文件边界：Decision needed [产品口径] |
| 关闭（显式紧急刹车） | `never` / `dontAsk` | Decision needed [产品口径]：是否允许在无 OS 沙盒时保留旧的无边界行为 |

矩阵中的「already so」只描述现有 Bash 或审批轴；「this ADR」描述本刀 Write/Edit 接线。
是否让两个轴正交组合、以及关闭 OS 沙盒后产品是否 fail-closed，属于产品口径，留给爸拍板。

## 后续施工单

- N-SANDBOX-TOOLLAYER-2：NotebookEdit 经过同一 seam，覆盖 notebook 原子写回。
- N-SANDBOX-TOOLLAYER-3：SkillCreate 经过同一 seam，覆盖自动创建 `SKILL.md`。
- N-SANDBOX-TOOLLAYER-4：network/* 的 WebSearch、Mermaid、截图、XLSX 临时/输出写入统一接线。
- N-SANDBOX-TOOLLAYER-5：Read 访问 `deniedReadRoots` 的拒绝码、文案和产品验收。
- N-SANDBOX-TOOLLAYER-6：审计所有 ToolContext/委派/协议适配器，确保 roots 沿 spawn 链完整传递。
- N-SANDBOX-TOOLLAYER-7：按产品拍板结果补齐 sandbox-mode × approval-policy 的禁用/降级运行时合同。
