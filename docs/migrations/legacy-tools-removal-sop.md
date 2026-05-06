# Legacy Tools Removal SOP

> 目标：把剩余 10 个 category 的 `src/main/tools/<cat>/` 完全干掉，让所有工具实现都
> 落到 `src/main/tools/modules/<cat>/`，wrapper boilerplate 全部消失。
>
> 调研对象：`network`（已部分清空：`tools/network/` 目录已被 1b5c8df2 拆成
> `tools/web/` `tools/media/` `tools/document/`，但 wrappers.ts 仍 wrap 17 个 legacy tool）
> 与 `connectors`（已 100% 完工：`tools/connectors/` 整个目录被删除）。
>
> 起草日期：2026-05-04 ｜ Base：`bce470a2` (main) ｜ Read-only 调研产物。

---

## 1. 现状速览（基于实际代码扫描）

父会话表里把"network 0 / connectors 0"理解为"完全 native 化"是部分对的：
- **connectors** 是真正完工典型（`tools/connectors/` 目录连 `index.ts` 都被删，
  `modules/connectors/wrappers.ts` 也被退役）。
- **network** 的 0 文件是因为 `1b5c8df2` 把目录拆到 `web/media/document` 后，
  原 `tools/network/` 物理上被清空。但其中 17 个 legacy tool 仍活在
  `tools/web/`、`tools/media/`、`tools/document/`，并被 `modules/network/wrappers.ts`
  通过 `wrapLegacyTool` 委托调用。

把口径统一到"modules/<cat>/ 里还有多少 wrapLegacyTool / buildLegacyCtxFromProtocol
delegate 调用"，下面是真实的剩余工作量：

| category | 剩余 delegate 调用 | 备注 |
|---|---|---|
| connectors | 0 | 100% 完工典型 |
| file | 0 | `modules/file/*.ts` 全 native（commit 1b390c1a 之后），但 `tools/file/` 目录还有 12 个 `*Poc.ts/*Decorated.ts`（POC 历史代码，**不是**当前在跑的实现） |
| shell | bash/process/taskOutput/killShell 仍 import `tools/shell/` 的 `backgroundTasks` `ptyExecutor` `dynamicDescription` 共享模块（不是 legacy Tool 类，是基础设施） | 真正 legacy Tool 类已不被引用 |
| search | 1（toolSearch wrapper 模式） | 单 tool |
| skill | 2（skill / skillCreate wrapper 模式） | 双 tool |
| lsp | 2（lsp / diagnostics wrapper 模式） | 双 tool |
| document | 1（docEdit 仍 import `tools/document/docxEdit` 的 executeDocxEdit） | 半结构化 |
| excel | 1（excelAutomate wrapper 模式） | 单 tool |
| mcp | 3（mcpInvoke / mcpUnified / mcpAddServer 全 wrapper） | 三 tool |
| network | 17（`modules/network/wrappers.ts`：ppt × 2、document gen × 6、media × 8、screenshotPage × 1） | 最大块 |
| planning | 12（`modules/planning/wrappers.ts` 全是 wrapLegacyTool） | 大块 |
| vision | 7（`modules/vision/wrappers.ts` 全是 wrapLegacyTool） | macOS AX 强耦合 |

**multiagent**（父会话表外）：`modules/multiagent/wrappers.ts` 仍 wrap 9 个 legacy tool。

---

## 2. 标准步骤（10 步 SOP）

参考 commit：
- network 三步走样板：
  - `1f47f187` Level 1（schema 提取 + 手写 wrapper-mode native shell，仍 delegate 给 legacy）
  - `901a8ed6` Level 2 pure IO native（`http_request` / `read_*` 全部 native 化，含 cross-tool dispatch shim 处理）
  - `379e57c0` Level 2 REST clients native（`jira` / `github_pr` / `twitter_fetch` / `youtube_transcript` / `academic_search`）
  - `80da6c6e` 后处理（提取 `invokeNativeFromLegacy` helper，dedupe Tier C 反向 shim）
- connectors 三步走样板：
  - `2f18a2ba` mail × 3（含 native 化、单测、删 legacy 文件、删 wrappers.ts 对应 export）
  - `11d222bf` reminders × 4
  - `302ce131` calendar × 4 + 删 `connectors/wrappers.ts` 整文件 + 删 `tools/connectors/` 整目录

两条线对照后提炼出 10 步可复制 SOP。**每步都有验证命令**，失败回退到上一步并 reset。

### Step 0 — 准备 base state

```bash
cd ~/Downloads/ai/code-agent
git fetch
git status                      # 必须 clean，或者只有跟本任务无关的改动
git rev-parse HEAD              # 记下来作回退点
git log --all --oneline -- src/main/tools/<cat>/ src/main/tools/modules/<cat>/ | head -30
```

**操作**：派 agent 接手前先在 fresh worktree 起，不要在 main 直接动。

**验证**：`npm run typecheck` 跑通，确认 base 编译没问题。

**失败回退**：如果 base 编译就有问题，先停掉这次迁移任务，让父会话先修 base。

---

### Step 1 — 列 tool 清单 + native 化优先级

把 `modules/<cat>/wrappers.ts` 里所有 `wrapLegacyTool(...)` export 列出来，
或扫 `modules/<cat>/*.ts` 找 `buildLegacyCtxFromProtocol` 调用点。

```bash
grep -n "wrapLegacyTool\|buildLegacyCtxFromProtocol" src/main/tools/modules/<cat>/*.ts
```

**操作**：每个 tool 单独成 1 个 commit（按 `2f18a2ba` 三 mail 并 1 commit 是因为关系紧密，可以 batch；散的分开）。

**验证**：`grep` 结果与父会话表对得上。

---

### Step 2 — Level 1（如果还没做）：把 schema 抽出来

照抄 `55bb8c93` / `1f47f187` 模式。对每个 tool：

1. 新增 `modules/<cat>/<toolName>.schema.ts`，pure type-only：
   ```ts
   import type { ToolSchema } from '../../../protocol/tools';
   export const <toolName>Schema: ToolSchema = { name: ..., description: ..., inputSchema: ..., category: ..., permissionLevel: ..., readOnly?, allowInPlanMode? };
   ```
2. 把 schema 从 legacy Tool（或 wrappers.ts 的 minSchema 占位）原样搬过来，
   描述/字段名/required 必须**逐字对齐** legacy 的 `inputSchema`（这是模型可见的契约）。
3. `modules/index.ts` 把对应 `registry.register` 调用从 `minSchema(...)` 占位换成
   eager `import { <toolName>Schema } from './<cat>/<toolName>.schema'`。

**验证**：
```bash
npm run typecheck
```

**失败回退**：`git checkout -- src/main/tools/modules/<cat>/<toolName>.schema.ts src/main/tools/modules/index.ts`。

---

### Step 3 — Level 1（如果还没做）：手写 wrapper-mode native module

照抄 `1f47f187` 的 `webFetch.ts` 模板（53 行 boilerplate）：

```ts
import type { ToolHandler, ToolModule, ToolContext, CanUseToolFn, ToolProgressFn, ToolResult } from '../../../protocol/tools';
import { <legacyTool> } from '../../<legacyDir>/<file>';
import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter';
import { <toolName>Schema as schema } from './<toolName>.schema';

class <ToolName>Handler implements ToolHandler<Record<string, unknown>, string> {
  readonly schema = schema;
  async execute(args, ctx, canUseTool, onProgress): Promise<ToolResult<string>> {
    const permit = await canUseTool(schema.name, args);
    if (!permit.allow) return { ok: false, error: `permission denied: ${permit.reason}`, code: 'PERMISSION_DENIED' };
    if (ctx.abortSignal.aborted) return { ok: false, error: 'aborted', code: 'ABORTED' };
    onProgress?.({ stage: 'starting', detail: schema.name });
    const legacyResult = await <legacyTool>.execute(args, buildLegacyCtxFromProtocol(ctx, canUseTool));
    onProgress?.({ stage: 'completing', percent: 100 });
    ctx.logger.debug('<toolName> done', { ok: legacyResult.success });
    return adaptLegacyResult(legacyResult);
  }
}

export const <toolName>Module: ToolModule<Record<string, unknown>, string> = {
  schema,
  createHandler() { return new <ToolName>Handler(); },
};
```

然后改 `modules/<cat>/wrappers.ts`：删掉对应 `wrapLegacyTool` export，加注释「已迁移到 Level 1，见 ./<toolName>.ts」。

修 `modules/index.ts`：把 register 的 loader 从 `(await import('./<cat>/wrappers')).<x>Module` 改成 `(await import('./<cat>/<toolName>')).<toolName>Module`。

**验证**：
```bash
npm run typecheck
npx vitest run tests/unit/tools/modules/<cat>/   # 如果有现成测试
```

**失败回退**：`git reset --hard <step0-hash>` 并诊断 schema 字段是否漏了 required / enum。

> **提示**：file/shell/search/skill/lsp/document/excel/mcp 这 8 个 category 已经在
> Level 1 状态（modules/<cat>/<tool>.ts 已经是 wrapper-mode native module，不是
> wrappers.ts 单文件聚合）。它们 Step 2-3 直接跳过，从 Step 4 开始。
> 真正还要做 Step 2-3 的：planning、vision、network 剩余 17 个、multiagent 剩余 9 个。

---

### Step 4 — Level 2：重写 native 实现，砍掉 legacy delegate

照抄 `2f18a2ba` mail.ts 模板（~220 行 native）。

1. 在同一个 `modules/<cat>/<toolName>.ts` 里把 handler 重写：
   - 五链：`canUseTool 闸门` → `abortSignal 检查` → `onProgress({stage:'starting'})` → 业务执行（直接调下游 service / fs / connector，**不再 import legacy Tool**）→ `onProgress({stage:'completing', percent:100})`。
   - 错误码规范化：`INVALID_ARGS` / `PERMISSION_DENIED` / `ABORTED` / `NOT_INITIALIZED` / `FS_ERROR` / `<DOMAIN>_ERROR`。
   - 走 `ctx.logger.debug` / `ctx.logger.warn`，不要再 import `services/infra/logger`。
   - 行为保真：legacy 输出格式（包括中文文案、表情符号、表头）必须 1:1 复刻，否则会污染评测集。
2. 删掉文件顶部 `import { <legacyTool> } from '../../<legacyDir>/<file>'` 和
   `import { buildLegacyCtxFromProtocol, adaptLegacyResult } from '../_helpers/legacyAdapter'`。
3. 如果 native 实现需要调下游服务，看 `getConnectorRegistry().get(...)`、
   `ctx.planningService`、`ctx.legacyToolRegistry` 等已有的 opaque service handle。

**验证**：
```bash
npm run typecheck
npx vitest run tests/unit/tools/modules/<cat>/<toolName>.test.ts
```

**失败回退**：`git checkout HEAD -- <toolName>.ts`，回到 Level 1 wrapper 模式。

---

### Step 5 — 写单测（行为保真验证集）

照抄 `tests/unit/tools/modules/connectors/mail.test.ts`（300 行）：

- Schema 验证：name / required / enum 枚举值断言
- 每个 action 至少 1 个 happy path
- canUseTool deny → `PERMISSION_DENIED`
- abortSignal aborted → `ABORTED`
- connector / 下游服务不可达 → `NOT_INITIALIZED`
- 边界用例（空数组、缺字段、超长输入）

**操作**：每个 native module 配 1 个 .test.ts，commit message 里写 `+N tests passed`。

**验证**：
```bash
npx vitest run tests/unit/tools/modules/<cat>/<toolName>.test.ts
```

**失败回退**：找出 native 实现与 legacy 的行为差异，修 native 不修测试。

---

### Step 6 — 处理 reverse shim（Tier C 回头依赖）

如果当前迁移的 tool 被 legacy "Automate" 系列 tool 反向 import（比如 `excelAutomate`、
`pdfAutomate`、`WebFetchUnifiedTool` 都需要调子 tool 的 native 实现），需要新增
`invokeNativeFromLegacy` shim（已经在 `modules/_helpers/invokeNativeFromLegacy.ts`）。

**操作**：
1. 在 native module 里 `export const execute<ToolName> = async (args, ctx, ...) => ...`，
   暴露纯函数版本（参考 `migrated/connectors/mail.ts` 的 `executeMail` 模式）。
2. 在 legacy 调用方（如 `tools/excel/excelAutomate.ts`）改用 `invokeNativeFromLegacy(executeXxx, ...)`。

**验证**：
```bash
npm run typecheck
grep -rn "from ['\"].*tools/<cat>/.*Tool['\"]" src/main/tools/  # 必须没有 legacy Tool import 残留
```

**失败回退**：保留 legacy Tool 单例的同时加个新 nativeExecute export，shim 慢慢替。

---

### Step 7 — 删 legacy 实现文件 + 更新 wrappers.ts

```bash
rm src/main/tools/<legacyDir>/<file>.ts
# 修 src/main/tools/<legacyDir>/index.ts 删 export
```

如果是当前 category 的最后一个 tool 完成，还要：
- 删 `modules/<cat>/wrappers.ts` 整文件（如果只剩注释）
- 删 `tools/<cat>/index.ts`
- 删 `tools/<cat>/` 空目录（可选，不删也行）
- 改 `eslint.config.js` 的 `no-restricted-imports` patterns，可以选择保留也可以删（建议保留作为永久 gate）

**验证**：
```bash
npm run typecheck
npx vitest run tests/unit/tools/modules/<cat>/
ls src/main/tools/<legacyDir>/        # 确认空 / 只剩 README
```

**失败回退**：`git restore <legacy file>` 把删掉的拉回来。

---

### Step 8 — 集成验证

```bash
npm run typecheck                  # 必须 0 errors
npx madge --circular src/main/     # 数量不超过基线（看 commit message 通常是 4-5）
npx vitest run                     # 全量必须通过
npm run build                      # 必须 success
npm run build:cli                  # 必须 success（与 build 独立！）
```

**失败回退**：定位是哪一步引入的，回退到对应 Step 的工作。

---

### Step 9 — 提交（不 push）

照抄 `2f18a2ba` commit message 风格：

```
refactor(p0-X): migrate <cat>/<tool1,tool2,...> to native protocol

- 新建 modules/<cat>/{<tool>}.ts native 实现
- 五链（parse/validate/canUseTool/abort/onProgress）+ 错误码规范化
- 新增 N 套单测覆盖 schema + 全部 action + 缺失边界（M tests）
- wrappers.ts 删除 N 个 export
- modules/index.ts register 块直连 native module
- 删除 legacy <cat>/{<tool>}.ts 及 barrel 导出

验证：
- tsc: 0 errors
- madge: N circular（基线不变 / -X）
- vitest <cat>: M/M passed
- vitest total: K/K passed
- build:cli: success

Co-Authored-By: Claude Opus 4.7 (1M context) <noreply@anthropic.com>
```

**操作**：每个独立 tool 一个 commit，或同一 batch（mail × 3、reminders × 4）一个 commit。

**失败回退**：`git reset HEAD~1`，问题修了再重提。

---

## 3. Category-by-category checklist

> 接手 agent：选你 own 的那一行，按 Step 0-9 走。

| # | Category | 待迁 tool 数 | Level 1 状态 | 工作量估时 | 特殊坑 |
|---|---|---|---|---|---|
| 1 | search | 1（toolSearch） | 已 Level 1 | **0.5 天** | 简单，依赖 `getRegistry`/`getProtocolRegistry`，注意 self-reference cycle |
| 2 | skill | 2（skill / skillCreate） | 已 Level 1 | **0.5 天** | 依赖 skill registry，需 mock `getSkillRegistry()` |
| 3 | lsp | 2（lsp / diagnostics） | 已 Level 1 | **1 天** | 依赖 LSP service 长连接，注意 abort 时关 LSP session |
| 4 | excel | 1（excelAutomate） | 已 Level 1 | **1 天** | reverse shim 已就位（`invokeNativeFromLegacy` in `tools/excel/excelAutomate.ts`），注意先迁完 sub-tools |
| 5 | document | 1（docEdit） | 已 Level 1 | **1 天** | docEdit 当前直接 import `executeDocxEdit`（不是 legacy Tool 类），把 executeDocxEdit 整体搬到 modules 即可 |
| 6 | mcp | 3（mcpInvoke / mcpUnified / mcpAddServer） | 已 Level 1 | **1.5 天** | 依赖外部 MCP 协议 stdio 客户端，需独立测 mcp protocol 边界 |
| 7 | multiagent | 9（task/teammate/spawn/wait/close/sendInput/agent_message/workflow/plan_review） | wrappers.ts 单文件聚合 | **2.5 天** | 用 `ctx.legacyToolRegistry / modelConfig` 走 opaque service handle 模式，commit message 注意"验证 opaque service handle 模式" |
| 8 | vision | 7（Browser/Computer/browserAction/browserNavigate/computerUse/screenshot/guiAgent）+ 已迁 visualEdit | wrappers.ts 单文件聚合 | **3 天** | macOS AX permission 强耦合 + 浏览器/computerUse 二选一，screenshot 涉及多屏。**强烈不建议简单 Level 2**，可以保留 wrapper 模式只把 schema 抽出来 |
| 9 | planning | 12（plan_read/plan_recover/plan_update/findings_write/Plan/task_list/task_get/task_create/task_update/TaskManager/AskUserQuestion/confirm_action/Explore） | wrappers.ts 单文件聚合 | **3 天** | 与 `ctx.planningService` opaque handle 紧耦合，AskUserQuestion 涉及 IPC 反向调用 renderer，需要保 IPC 协议不变 |
| 10 | network 剩余 | 17（ppt_generate/ppt_edit + 6 doc gen + 8 media + screenshot_page） | 部分 Level 1 | **5 天** | ppt 系统巨大（`tools/media/ppt/` 30+ 文件），media 涉及 sharp / ffmpeg / 大量 SDK。**ppt 单独拆 1 个 PR**，其他 8+1 拆 2-3 个 PR |

**总工作量估算**：约 18-19 个工作日（不含 review / 评测集回归 / 联调）。

---

## 4. 派活顺序建议

### Wave 1 — 低风险并行（可同时派 3 个 agent，约 0.5-1 天完工）

不耦合任何 cross-cutting 服务，单 tool / 双 tool，无 IPC：

- **A1：search**（1 tool，0.5 天）
- **A2：skill**（2 tool，0.5 天）
- **A3：lsp**（2 tool，1 天）

通过验证：在 Wave 1 跑通后看一下三个 agent 的产物是否符合 SOP，纠正 SOP 后再放 Wave 2。

### Wave 2 — 中等风险并行（可同时派 3 个 agent，约 1-2 天完工）

各自独立的 service domain，不交叉：

- **B1：excel**（1 tool + reverse shim 已就位，1 天）
- **B2：document**（1 tool，1 天）
- **B3：mcp**（3 tool，1.5 天）

### Wave 3 — 大块串行（每个独立派 1 agent，2.5-3 天/个）

需要单独走 review，避免互相污染：

- **C1：multiagent**（2.5 天）
- **C2：planning**（3 天）

> planning 与 multiagent 都依赖 `ctx.<service>` opaque handle 模式，先做 multiagent
> 验证模式 OK 再做 planning，不要并行。

### Wave 4 — 高风险，特殊处理

- **D1：vision**（3 天）— 建议**只做到 Level 1（schema 抽出来 + wrapper-mode native shell）**，
  Level 2 不动。原因：macOS AX 行为难自动化测试，real device 验证成本高，
  Tier C 完成后再单独立项。
- **D2：network 剩余**（5 天）— 拆成 3 个 sub-PR：
  - D2a：ppt（ppt_generate + ppt_edit），单独 PR，2 天
  - D2b：document gen 6 个（docx/excel/pdf × 5/xlwings），1.5 天
  - D2c：media 8 + screenshot_page，1.5 天

---

## 5. 派 agent 的 brief 模板

```
你是 P1 后置任务的 owner，只迁移 <category> 这一个 category。

入口：~/Downloads/ai/code-agent
SOP：docs/migrations/legacy-tools-removal-sop.md（必读）
样板 commit：2f18a2ba（connectors/mail，最干净的 native 化）
配套样板：1f47f187（network/webFetch，Level 1 模式）

你的 scope：
- 只动 src/main/tools/modules/<cat>/、src/main/tools/<legacyDir>/、tests/unit/tools/modules/<cat>/、modules/index.ts 这 4 个位置
- 不要动 ESLint config（除非你是最后一个完工的），不要动 protocol 层基础设施
- 不要 push，只 commit 到本地，等父会话 review

完工条件（缺一不可）：
- npm run typecheck → 0 errors
- npx vitest run tests/unit/tools/modules/<cat>/ → 全 pass
- npm run build && npm run build:cli → success
- madge 不超基线
- modules/<cat>/wrappers.ts 中 wrapLegacyTool 调用数 = 0（或 wrappers.ts 整文件删除）
- src/main/tools/<legacyDir>/ 下不再有被 modules/<cat>/ 引用的文件

3 次连续失败请停手，把进度和卡点写到 commit message，让父会话接手。
```

---

## 6. 不要做的事

- **不要做 cross-category 改动**：每个 agent 只动 own 的 category。`modules/_helpers/` 是
  共享层，**禁止改**，除非父会话明确同意。
- **不要碰 ESLint gate**：`no-restricted-imports` 的 `**/tools/<cat>/**` 模式
  即使该 category 完成了，也保留作为永久护栏（防回滚）。
- **不要重写 schema 字段名/required**：legacy 的 inputSchema 是模型可见契约，
  字面改动 = 评测回归风险。description 可以润色但不要改 enum / required / type。
- **不要省单测**：每个 native 模块至少要补上 schema 验证 + 全 action happy path +
  permission deny + abort + 下游不可达，参考 `mail.test.ts` 的覆盖度。
- **不要并行做 vision Level 2 和 network media Level 2**：两者都涉及外部 SDK / 系统能力，
  先单点验证再扩展。

---

## 7. 验证 SOP 自身的成功标准

10 个 category 全部按本 SOP 完成后，运行：

```bash
# 1. 不再有任何 wrapLegacyTool 调用
grep -rn "wrapLegacyTool" src/main/tools/modules/  # 期望：0 或只剩 _helpers/legacyAdapter.ts 的定义

# 2. 不再有 buildLegacyCtxFromProtocol 在 module 实现里
grep -rn "buildLegacyCtxFromProtocol" src/main/tools/modules/ | grep -v _helpers  # 期望：0

# 3. legacy 目录基本清空
for c in file shell search skill lsp planning network document excel mcp connectors vision multiagent; do
  echo "=== $c ==="
  ls src/main/tools/$c/ 2>&1 | grep -v __tests__
done
# 期望：要么目录不存在，要么只剩共享基础设施（如 shell/backgroundTasks.ts、
# shell/ptyExecutor.ts，这些是 native module 主动 import 的，不算 legacy Tool）

# 4. 删掉 _helpers/legacyAdapter.ts（最后一步，确认 0 引用后才删）
grep -rn "from.*_helpers/legacyAdapter" src/  # 期望：0

# 5. 全测试 + 构建
npm run typecheck && npx vitest run && npm run build && npm run build:cli
```

如果 1-5 全过，恭喜，迁移完结。删掉 `tools/LEGACY.md`、本 SOP 文件移到
`docs/archived/`，ESLint patterns 是否保留由父会话决定。

---

## 附录 A — 关键 commit 对照表

| Commit | 内容 | SOP 对应步骤 |
|---|---|---|
| `e83477aa` | P0-5 protocol layer + file 第 1 批迁移（建立 ToolModule 形态） | 历史背景 |
| `78c3bc42` | P0-5 batch 5：connectors 11 工具 wrapper 化（全 wrapLegacyTool） | Step 3 起点（Level 1 起手） |
| `0b4c0dfc` | P0-6.3 batch 7：document + simple generators native | Step 4 样板 |
| `901a8ed6` | P0-6.3 batch 8：network-read pure IO native（含 reverse shim） | Step 4 + Step 6 样板 |
| `379e57c0` | P0-6.3 batch 9：network REST clients native | Step 4 样板 |
| `2f18a2ba` | mail × 3 native（最干净 case） | Step 4-5-7-9 完整样板 |
| `11d222bf` | reminders × 4 native | Step 4-5-7-9 复用 |
| `302ce131` | calendar × 4 native + 删整个 connectors/wrappers.ts + 删 tools/connectors/ 整目录 | Step 7 收尾样板 |
| `80da6c6e` | 提取 `invokeNativeFromLegacy` helper（reverse shim dedupe） | Step 6 工具 |
| `c2e0fb1a` | rename `tools/migrated` → `tools/modules` | 历史背景 |
| `55bb8c93` | P0-7 plan A：50 schema 抽到 sibling .schema.ts | Step 2 样板 |
| `1f47f187` | network web_fetch/web_search/WebFetchUnified Level 1 | Step 2-3 样板 |

## 附录 B — 关键文件清单

- `src/main/tools/LEGACY.md` — legacy 边界声明
- `src/main/tools/modules/_helpers/legacyAdapter.ts` — `wrapLegacyTool` / `buildLegacyCtxFromProtocol` / `adaptLegacyResult`
- `src/main/tools/modules/_helpers/invokeNativeFromLegacy.ts` — reverse shim（native → legacy 调用）
- `src/main/tools/modules/index.ts` — 唯一注册入口（718 行）
- `eslint.config.js` — `no-restricted-imports` gate
- `src/protocol/tools/` — ToolModule / ToolHandler / ToolContext / CanUseToolFn 类型定义
