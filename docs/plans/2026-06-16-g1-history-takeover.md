# G1 — 接管 `~/.claude` / `~/.codex` 历史（只读单向导入 + 续聊）

> 日期：2026-06-16
> 状态：待执行
> 前提：用户不 review 代码，质量靠**验证闸门**（typecheck / targeted 测试 / E2E / 高风险落库走 /multi-review）。
> 关联现状摸底：基础设施 95% Ready（解析、list/preview、落库均完成），缺 transform + resolver + renderer UI 三步。

---

## 1. 目标与边界

### G1 做什么（本计划范围）

- **只读单向导入**：扫描 `~/.claude/projects/<encoded>/<uuid>.jsonl` 和 `~/.codex/sessions/YYYY/MM/DD/rollout-*.jsonl`，让用户在 Neo 内列出 / 预览 / 选中导入外部 CLI 会话。
- **落库为本地 Session**：把 preview 消息 normalize 成标准 `Message[]`，落到本地 `sessions` / `messages` 表，`origin: 'import'` 标记来源。
- **导入后续聊**：在导入会话上发起新一轮对话，向底层 adapter 传 `--resume <externalSessionId>`（仅当该引擎支持且原始会话文件仍可定位），让 Claude Code / Codex CLI 在原始上下文上续接。

### G1 明确不做（划给 G2）

- ❌ **不做双向回写**：绝不修改、追加、删除 `~/.claude` / `~/.codex` 下任何原始文件。导入是只读快照。
- ❌ 不把 Neo 内的新消息同步回外部 CLI 历史文件。
- ❌ 不做增量同步 / watch / 自动重导。每次导入都是用户显式触发的一次性快照。
- ❌ 不做跨引擎会话合并、不做会话编辑器。

> 读 / 写边界一条线：G1 对外部目录**只 read，不 write**。任何 write 回外部目录的需求一律记为 G2，不在本计划内实现，也不留半成品代码。

---

## 2. 涉及文件锚点

| 层 | 文件 | 现状 | G1 动作 |
|----|------|------|---------|
| 解析 | `src/main/session/claudeSessionParser.ts` | ✅ 完整 | 不改，复用 |
| 解析 | `src/main/session/codexSessionParser.ts` | ✅ 完整 | 不改，复用 |
| 导入 | `src/main/services/agentEngine/agentEngineHistoryImport.ts` | ✅ list/preview 完成 | **新增 `buildImportableSession()`** |
| 契约 | `src/shared/contract/agentEngine.ts` | `import_sessions` / `resume` / `origin:'import'` 已声明 | 新增 import 请求/响应类型 |
| IPC | `src/main/ipc/agentEngine.ipc.ts` (现 list/preview case ~185-192) | 暴露 list/preview | **新增 `case 'importSessions'`** |
| IPC | `src/main/ipc/session.ipc.ts` (`session:import` ~83-84) | ✅ import 通道已暴露 | 复用 |
| 落库 | `src/main/services/.../sessionManager.ts` (`importSession()` ~1144-1187) | ✅ 创建 session + 逐条 addMessage | 复用，注入 `origin:'import'` 元数据 |
| 落库 | `src/main/services/core/repositories/SessionRepository.ts` (`messages` 表 ~410-429) | ✅ addMessage / replaceMessages | 复用 |
| 注册 | `src/main/services/agentEngine/agentEngineRegistry.ts` (capability 分配 62/86/127) | 声明但无 resolver | **接 import 实现；resume 仅在文件可定位时启用** |
| Adapter | `src/main/services/agentEngine/claudeCodeAdapter.ts` (~531 硬编码 `--no-session-persistence`) | 未传 `--resume` | **续聊路径传 `--resume`** |
| Adapter | `src/main/services/agentEngine/codexCliAdapter.ts` (~149-169) | 未传 resume | **续聊路径传 codex 对应 resume 标志** |
| Renderer | SessionPanel / 入口 | ❌ 无 UI | **新增 `ImportHistoryModal.tsx` + 入口按钮** |
| Capability | `src/main/shellCapabilities.ts` (listHistory/previewHistory ~77-79) | 已注册 | 复用，必要时补 importSessions |

---

## 3. 分步实现

### Step 1 — Preview 落库（transform pipeline + import resolver）

**目标**：选中一个外部会话 → 落成本地 Session（含全部消息，非仅 12 条 preview 截断）。

实现要点：
1. `agentEngineHistoryImport.ts` 新增 `buildImportableSession(request)`：
   - 入参 `{ engine, externalSessionId | sourcePath, dedupeKey }`。
   - 复用 parser 全量解析（**不要用 12 条的 previewLimit**，preview 是给 UI 看的；落库要全量消息），按引擎走 `parseClaudeSession()` / `parseCodexSession()`。
   - normalize 成标准 `Message[]`：`role` → `messages.role`、文本 → `messages.content`、`timestamp` → `messages.timestamp`、id 生成 `msg_<ts>_<uuid>`（对齐 sessionManager ~1173 的现有规则）。
   - 工具调用 / thinking 块的降级策略：G1 先把 tool_use / tool_result / thinking 折叠进对应 assistant/user 文本（保证可读、可续聊），不强求结构化还原。把这条决策写进会话 metadata，便于 G2 升级。
   - 产出带 `origin:'import'` + `source: { engine, externalSessionId, sourcePath, importedAt, parserVersion }` 的可导入对象。
2. `agentEngine.ipc.ts` 新增 `case 'importSessions'`：调用 `buildImportableSession()` → `appService.importSession()` → 返回 `{ sessionId }`。
3. 去重：导入前用 `source.externalSessionId` 查本地是否已存在同源 session（见 §5 脏活）。

**验证 Step 1**：
```bash
# 类型 + lint
cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck && npm run lint

# targeted 单测（新建 tests/integration/historyImport.transform.test.ts）
#  - 喂 fixture jsonl（claude + codex 各一）→ 断言 Message[] 条数、role 映射、timestamp 单调、id 格式
#  - 断言 origin==='import' 且 source 元数据完整
#  - 断言落库后从 SessionRepository 读回的消息与解析一致（roundtrip）
npx vitest run tests/integration/historyImport.transform.test.ts

# 高风险闸门：落库 transform 是数据写入路径，跑 /multi-review
#   /multi-review src/main/services/agentEngine/agentEngineHistoryImport.ts src/main/ipc/agentEngine.ipc.ts
```
留证：vitest 输出 + multi-review 报告归档到 `docs/audits/2026-06-16-g1-step1-*.md`。fixture 放 `tests/fixtures/history/{claude,codex}/`，从真实 `~/.claude` / `~/.codex` 各拷一份脱敏样本（删路径/秘钥）。

---

### Step 2 — Renderer Import 入口

**目标**：用户能在 UI 里浏览外部会话、预览、点导入。

实现要点：
1. 新增 `src/renderer/components/.../ImportHistoryModal.tsx`：
   - Tab/筛选：Claude Code / Codex CLI。
   - 列表：`ipc.agentEngine('listHistory', { engine, limit })` → 渲染 `title / messageCount / updatedAt / canImport / diagnostics`，`canImport===false` 的灰显 + 给出诊断原因。
   - 预览：选中行调 `ipc.agentEngine('previewHistory', { engine, externalSessionId, previewLimit })` → 渲染消息气泡。
   - 导入：确认按钮调 `ipc.agentEngine('importSessions', { engine, externalSessionId })`，成功后跳转到新建的本地 session。
2. 入口挂载：SessionPanel 顶部 "导入历史" 按钮（首选）；同时在空状态（无 session 时）放一个引导入口。
3. 来源解释（见 §5）：列表与导入后的 session 详情都要明确标 "来自 Claude Code / Codex CLI · 导入于 X · 只读快照"。

**验证 Step 2**：
```bash
cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck && npm run lint

# E2E：导入链路（tests/e2e 下新增 history-import.spec）
#  路径：打开 app → 点"导入历史" → 列表非空 → 选一条 → 预览出消息 → 点导入 → 本地出现新 session 且消息可见
npx playwright test tests/e2e/history-import.spec.ts
# 若 Playwright MCP 卡住：清 mcp-chrome profile 的 Singleton 锁（见 memory project_code_agent_dev_qa）
```
留证：Playwright trace + 导入前后截图（列表 / 预览 / 导入后 session）归档到 `docs/audits/2026-06-16-g1-step2-e2e/`。

---

### Step 3 — 续聊传 `--resume`

**目标**：在导入的 session 上发新消息时，底层 CLI 在原始上下文续接。

实现要点：
1. 续聊触发判定：仅当 `session.engine.origin === 'import'` **且** `source.externalSessionId` 对应的原始文件仍可在磁盘定位时，才走 resume 路径；否则降级为"本地独立续聊"（不传 resume，纯用已落库消息当上下文），并在 UI 提示 "原始会话文件已不可用，将以本地快照续聊"。
2. `agentEngineRegistry.ts`：把 `resume` capability 从"仅 native 声明"落到 Claude/Codex 的执行解析——即在构建启动参数时，依据 origin + 文件可达性决定是否注入 resume。
3. `claudeCodeAdapter.ts`：续聊路径下，去掉/不冲突地处理现有硬编码 `--no-session-persistence`（~531），改为传 `--resume <externalSessionId>`。**注意**：`--resume` 与 `--no-session-persistence` 的组合行为需先用 `rtk proxy` 或手动 CLI 验证一次，不能想当然。
4. `codexCliAdapter.ts`（~149-169）：用 Codex 对应的 resume/继续会话标志（按 codex 版本确认参数名），同样仅在文件可达时注入。
5. resume 失败的兜底：CLI 报"会话不存在/格式不兼容"时，捕获并降级到本地快照续聊，不让整轮对话失败。

**验证 Step 3**：
```bash
cd /Users/linchen/Downloads/ai/code-agent && npm run typecheck && npm run lint

# 先手动验证 CLI 标志真实行为（留命令输出做证据，不靠假设）
#   Claude: rtk proxy claude --resume <id> --print "继续" 看是否加载到原始上下文
#   Codex:  对应 resume 标志同样实测
# targeted 单测：断言启动参数装配
#   - origin==='import' + 文件可达 → 参数含 --resume <id>，不含与之冲突的 no-persistence
#   - origin==='import' + 文件缺失 → 不含 --resume，走本地快照分支
#   - origin!=='import' → 行为不变（回归保护）
npx vitest run tests/integration/agentEngine.resumeArgs.test.ts

# E2E：导入 → 续聊 → 断言回复体现了原始上下文（用一个 fixture 会话里提过的事实，问 CLI 能否答出）
npx playwright test tests/e2e/history-import-resume.spec.ts

# 高风险闸门：adapter 参数装配影响真实子进程行为，跑 /multi-review
#   /multi-review src/main/services/agentEngine/claudeCodeAdapter.ts src/main/services/agentEngine/codexCliAdapter.ts src/main/services/agentEngine/agentEngineRegistry.ts
```
留证：CLI 实测输出 + vitest + Playwright trace + multi-review 报告归档到 `docs/audits/2026-06-16-g1-step3-*`。

---

## 4. 验证闸门总览（每步必过才进下一步）

| 闸门 | 命令 | 适用步骤 |
|------|------|----------|
| 类型 | `npm run typecheck` | 1/2/3 全部 |
| Lint | `npm run lint` | 1/2/3 全部 |
| 单元/集成 | `npx vitest run <targeted spec>` | 1（transform/roundtrip）、3（resumeArgs） |
| E2E | `npx playwright test tests/e2e/history-import*.spec.ts` | 2（导入链路）、3（续聊上下文） |
| 多模审查 | `/multi-review <files>` | 1（落库 transform）、3（adapter 参数装配）—— 数据落库与子进程参数为高风险面 |
| CLI 实测 | `rtk proxy claude/codex --resume ...` 留输出 | 3（resume 标志真实行为） |

规则：任一闸门红 → 停在当前步修复，不跨步。所有证据归档到 `docs/audits/2026-06-16-g1-*`，作为"用户不 review 代码"前提下的质量留痕。

---

## 5. 脏活与风险

| 项 | 风险 | 对策 |
|----|------|------|
| **导入去重** | 同一外部会话被反复导入，本地堆重复 session | 落库前按 `source.externalSessionId` 查重；已存在则在 UI 提示"已导入过"，提供"跳过 / 重新导入覆盖"二选一，不静默重复建 |
| **来源解释** | 用户分不清哪些 session 是导入的、是否会污染原始 CLI 历史 | session 详情与列表显式标 "来自 X · 导入于 Y · 只读快照，不会修改原始文件"；导入对话框文案明确单向只读 |
| **权限边界** | Neo 访问 `~/.claude` / `~/.codex` 触发 macOS 文件权限 / 沙箱拦截，或读到他人/敏感会话 | 仅在用户显式点导入时读取；读失败给清晰错误而非静默空列表；落库的脱敏快照不含 API key（解析层若带出秘钥需在 transform 阶段过滤）；fixture 必须脱敏 |
| **Claude/Codex 私有格式变更** | 上游 JSONL schema 升级导致 parser 解析失败或字段缺失 | parser 已支持错误恢复（diagnostics）；transform 遇未知行类型降级为可读文本并记 diagnostic，不整会话失败；落库写入 `parserVersion`，便于排查；`canImport===false` 时在 UI 给出诊断原因而非崩溃 |
| **`--resume` 标志行为不确定** | CLI 版本差异 / 与 `--no-session-persistence` 冲突 / 原始文件已删 | Step 3 强制 CLI 实测留证；文件不可达时降级本地快照续聊；resume 失败有兜底，不让对话整轮失败 |
| **大会话内存** | 全量解析超大 jsonl 落库时内存峰值 | 复用 parser 的流式能力；落库走逐条 addMessage（已有），不一次性 in-memory 拼大数组 |

---

## 6. 交付物清单

- [ ] `agentEngineHistoryImport.ts` 的 `buildImportableSession()`（含去重 + 脱敏 + 全量解析）
- [ ] `agentEngine.ipc.ts` 的 `case 'importSessions'`
- [ ] `agentEngine.ts` import 请求/响应契约类型
- [ ] `ImportHistoryModal.tsx` + SessionPanel 入口 + 空状态引导
- [ ] `claudeCodeAdapter.ts` / `codexCliAdapter.ts` / `agentEngineRegistry.ts` 的 resume 装配（含文件可达性判定与兜底）
- [ ] 测试：`tests/integration/historyImport.transform.test.ts`、`tests/integration/agentEngine.resumeArgs.test.ts`、`tests/e2e/history-import*.spec.ts`
- [ ] 脱敏 fixture：`tests/fixtures/history/{claude,codex}/`
- [ ] 审计证据：`docs/audits/2026-06-16-g1-step{1,2,3}-*`
