# P0-1 施工报告：记忆路径权威覆盖面翻转 fail-closed

工单：`code-agent-private-archive/docs/plans/tickets/2026-08-07-P0-1-记忆路径权威覆盖面翻转fail-closed-工单.md`
日期：2026-08-07　｜　基点：`origin/main`

## 结论先说

改动只有两处生产代码（一处判定条件 + 一行 schema 声明），外加一个表驱动的覆盖面门。
**没有按工单原方案做"注册期硬门"**——第 1 步的量化否掉了它，理由见 §3。

## 1. 第 1 步量化：覆盖面到底什么样

工单要求先枚举再决策。手工读 48 个 schema 必漏，改用探针脚本从**真实注册表**
（`registerMigratedTools` 是 schema 的 single source of truth）取数：

```
TOTAL 129 个工具  {read: 44, write: 45, execute: 26, network: 14}
非 read 的 85 个里，assess 完全够不着的：64 个
```

64 这个数字**吓人但不精确**——绝大多数零覆盖工具根本不落盘（reminders / calendar /
task / plan / mail 都是 DB 或系统服务）。按"能不能自由指定落盘路径"重新分类：

### A 类：非 write 档 + 带路径形态参数 + 无声明（6 个）

通用扫描原先门在 `permissionLevel === 'write'`，这 6 个全被挡在扫描面外：

| 工具 | 档位 | 路径参数 | 判定 |
|---|---|---|---|
| `git_worktree` | execute | `path` | **真缺口** — `git worktree add <path>` 会在该路径建目录和文件 |
| `screenshot_page` | network | `output_path` | **真缺口** — 实现里 2 处写盘，能把截图落进记忆目录 |
| `ppt_generate` | network | `output_path` / `template_path` | **真缺口** — 实现里 5 处写盘 |
| `image_analyze` | network | `path` | 不是缺口 — 只读图片 |
| `steer_task` | execute | `target` | **误报** — `target` 是任务标识，被后缀名撞上 |
| `cancel_task` | execute | `target` | **误报** — 同上 |

两条误报本身是证据：**按参数名判路径不可靠**，所以它只能是兜底而不能是唯一防线。
误报的代价是安全方向的（多一次确认），可以接受。

### B 类：write 档 + 参数名不含路径后缀 + 无声明（25 个）

通用扫描按参数名后缀 `file/path/directory/destination/target` 匹配，这 25 个一个都不匹配。
逐个核实实现里有没有写盘：

- `findings_write` / `propose_role` / `propose_team_recipe` — grep 写盘 API **0 处**，走 DB/store，不是缺口
- `reminders_*` / `calendar_*` / `task_*` / `plan_*` / `Plan` / `PlanMode` / `mail_*` — 系统服务或 DB，不落文件
- `SkillCreate` — 写盘，但目标是 `getSkillsDir()` 下的固定目录，路径不由参数决定，不是缺口
- `mcp_add_server` — 写 MCP 配置，路径固定
- `memory_amend` — 见 §4，属于另一条通道

### 工单点名要核实的两族，结论都是"不算缺口"

- **子代理族**（`spawn_agent` / `Task` / `AgentSpawn` / `send_input` / `workflow*`）：
  `src/host/agent/subagentToolRuntime.ts:25` 新建 `ToolExecutor` 执行子代理的工具调用，
  会重新过 `toolExecutor.ts:437` 的同一道 assess。**派活不绕过边界**，按工单要求缩小范围。
- **`SkillCreate`**：如上，路径不可控。

## 2. 修法

### 2.1 主修：通用扫描对所有非 read 工具生效（`directiveMemoryPathAuthority.ts`）

```diff
- const genericTargets = input.definition.permissionLevel === 'write'
+ const genericTargets = input.definition.permissionLevel !== 'read'
```

一行覆盖 A 类全部。选它而不是"给三个工具补声明"，是因为落盘能力根本不跟
`permissionLevel` 走——`bash` 就是 `execute` 档，`screenshot_page` 是 `network` 档。
继续按名字补声明只能修掉今天数出来的这三个，明天新增的 network 档写盘工具照漏。

### 2.2 补声明：`terminal_write` 加 shell 类描述符（`terminal.schema.ts`）

它把 `input` 带 `\r` 送进用户的活 shell（`terminal.ts:337`），和 `bash` 同构：路径藏在
命令字符串里，参数名扫描抓不住重定向目标。补 `{ kind: 'shell', commandParameter: 'input' }`。

值得记一笔：该工具的 description 原文承诺 "Every write goes through the same command
safety checks and approval flow as bash"，而在补上这行之前，**记忆路径权威这一环并不在其中**。

## 3. 为什么没做工单原定的"注册期硬门"

原方案是：可写/可执行档的工具必须声明 `pathAuthority`，否则注册期报错。量化之后否掉：
85 个非 read 工具里真正需要声明的只有命令字符串那一类（`Bash` / `terminal_write`），
硬门会逼另外 80 多个不落盘的工具写一行无意义的空声明或豁免标记——那是把噪声当防线，
且豁免出口一多，门本身就形同虚设。

改成"翻默认值"：通用扫描默认覆盖所有非 read 工具（新增工具自动进扫描面），
只有"参数名不像路径"的那一类才需要显式声明，并由 §4 的门钉住。

## 4. 记录但未实施：DB 式记忆是另一条通道

`memory_amend`（write 档）能 `update` / `forget` **DB 里的 MemoryRecord**，
`memoryAmend.ts:9-10` 注释明写"只管 DB 侧，不碰文件式记忆"。ADR-054 这道门守的是
**文件路径**，所以 DB 式记忆的删改完全不在其管辖内，也没有等价的确认要求。

这不是本工单的漏洞，是边界之外的一块。要不要把持久记忆的确认语义从"路径"扩到
"记忆实体"（含 DB），是产品决策，**留待拍板，本次不擅自扩范围**。

## 5. 门与变异验证

新增 `tests/unit/tools/directiveMemoryPathAuthorityCoverage.test.ts`，31 条用例，
全部从真实注册表取数，不手抄清单：

- **表驱动**：所有非 read 且带路径形态参数的工具，各生成一条"指向记忆目录必须要求确认"。
  新增这类工具自动多一条用例。
- **命令字符串类**：`Bash` / `terminal_write` 必须有 shell 类声明；另有一条真拦截用例
  （`echo pwned > <memoryDir>/foo.md` → `requiresConfirmation === true` 且 targets 含 foo.md）。
- **零候选 fail-closed**：注册表为空或候选为 0 时报红。这条不是摆设——
  `getProtocolToolSchemas()` 在未初始化时返回 `[]`，探针第一版正是因此静默扫到 0 个工具，
  门若照抄那个取数方式就会假绿。
- **read 档不进扫描面**：钉住这次没有顺手把 read 档也拖进来（那只会徒增误报）。

### 双向变异验证（实跑）

| 变异 | 结果 |
|---|---|
| 主修回退成 `=== 'write'` | **6 条转红** — 正是 A 类那 6 个工具 |
| 摘掉 `terminal_write` 的 shell 声明 | **2 条转红** — 声明用例 + 真拦截用例 |
| 全部还原 | 31 条全绿 |

门还当场抓到了我自己写错的清单：第一版把 bash 工具名写成小写 `bash`，注册表里实际是
`Bash`，用例直接报红。已改用仓库既有的 `sameToolName` 比较，避免工具改名后这条静默跳过。

## 6. 全量验证

- `npx tsc --noEmit` → 通过
- `node scripts/tsc-tests-ratchet.mjs` → current=0 baseline=0，未新增
- `npx vitest run tests/unit/tools tests/unit/memory tests/scripts` → **251 文件 2689 用例全绿**

## 7. 遗留

- `Process` 工具的 `data` / `input` 参数写的是某个已运行进程的 stdin，能否落盘取决于那个
  进程本身，没有"命令字符串"语义，本次未加声明。若将来发现实际滥用路径，再按 shell 类补。
- §4 的 DB 式记忆通道待产品拍板。
