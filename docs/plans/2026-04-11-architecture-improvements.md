# 架构优化计划

> 日期: 2026-04-11
> 来源: 架构合理性分析（对标 Claude Code / Cursor / Aider / OpenHands）
> 状态: Phase 1 ✅ | Phase 2 ✅ | Phase 3.2 ✅ | Phase 3.1 待定

## 概览

6 项改进，分 3 个阶段。Phase 1 为低风险清理（可立即执行），Phase 2 为系统加固，Phase 3 为新能力建设。

```
Phase 1: 清理死代码         ─── 预计 2-3h ─── 零行为变更
Phase 2: 权限 & 记忆加固    ─── 预计 4-6h ─── 内部重构
Phase 3: OS 沙箱 & Repo Map ─── 预计 2-3d ─── 新能力
```

---

## Phase 1: 清理死代码（零行为变更）

### 1.1 移除运行时 generationId（30 min）

**现状**：所有会话硬编码 `generationId: 'gen8'`，32 个文件引用，零条件分支基于此值做决策。

**改动范围**：

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1 | `src/shared/types/session.ts` | 移除 `generationId?: string` 字段 |
| 2 | 32 个引用文件 | 移除赋值（`generationId: 'gen8'`）和传递 |
| 3 | `src/main/services/core/databaseService.ts` | `generation_id` 列保留（历史兼容），不再写入 |
| 4 | `src/main/services/cloud/cloudConfigService.ts` | 删除 `getPrompt(genId)` 死方法 |
| 5 | `src/main/services/cloud/featureFlagService.ts` | 删除 `isGen8Enabled()` 死方法 |
| 6 | `src/main/services/cloud/builtinConfig.ts` | 删除 gen8 prompt 构建逻辑（~10 行） |

**验证**：`npm run typecheck` 通过即可，无行为变更。

### 1.2 CommandMonitor 合并进 CommandSafety（1h）

**现状**：
- `CommandMonitor`（483 行，`src/main/security/commandMonitor.ts`）：25 个危险命令正则，**从未被 import**
- `CommandSafety`（356 行，`src/main/security/commandSafety.ts`）：44 安全命令白名单 + 11 条件安全命令，**活跃使用**

**改动范围**：

| 步骤 | 操作 |
|------|------|
| 1 | 从 CommandMonitor 提取有价值的危险模式（fork bomb、disk overwrite、dd to device 等 CommandSafety 未覆盖的） |
| 2 | 合并到 CommandSafety 的 `isKnownSafeCommand()` 反向逻辑或新增 `isDangerousCommand()` 导出 |
| 3 | 保留 `riskLevel` 和 `suggestion` 字段（对用户有价值的信息） |
| 4 | 删除 `commandMonitor.ts`，更新 `security/index.ts` 导出 |
| 5 | 删除 `tests/unit/security/commandMonitor.test.ts`，将有价值的用例迁移到 commandSafety 测试 |

**验证**：`npm run typecheck` + 跑 security 相关测试。

---

## Phase 2: 权限 & 记忆加固

### 2.1 GuardFabric 接入 agentLoop（3-4h）

**现状**：
- `GuardFabric`（207 行）：多源竞争协调器 + Topology 规则，**定义完整但从未实例化**
- 当前权限路径：`permissions.ts` → 直接调 `getPolicyEngine().evaluate()`
- GuardFabric 设计意图：PolicyEngine 作为 GuardSource 之一，与 HookSource 等其他源协调

**接入方案**：

```
当前:
  toolExecutionEngine → permissions.ts → PolicyEngine.evaluate()

改为:
  toolExecutionEngine → permissions.ts → GuardFabric.evaluate()
                                            ├─ PolicyEngineSource (已有)
                                            ├─ HookGuardSource (已有，hookSource.ts)
                                            └─ Topology 规则 (多 Agent 场景)
```

| 步骤 | 操作 |
|------|------|
| 1 | `src/main/agent/permissions.ts`：将 `getPolicyEngine().evaluate()` 调用替换为 `getGuardFabric().evaluate()` |
| 2 | 确保 GuardFabric 返回的 `GuardDecision` 映射到现有 `PermissionAction`（allow/prompt/deny → allow/prompt/deny） |
| 3 | 传入 `topology` 参数：主 Agent 为 `'main'`，子 Agent 根据角色传 `'async_agent'`/`'teammate'`/`'coordinator'` |
| 4 | `src/main/agent/runtime/toolExecutionEngine.ts` 或 `agentOrchestrator.ts`：在创建 Agent 执行上下文时标记 topology |
| 5 | HookGuardSource 接入：已有 `src/main/permissions/hookSource.ts`，确认 hooks 能通过 GuardFabric 参与权限决策 |

**关键约束**：
- GuardFabric 的 `deny > ask > allow` 竞争规则与 PolicyEngine 现有行为一致，不会改变已有权限结果
- 新增的 Topology 规则只对子 Agent 生效（`async_agent` 禁 bash、`coordinator` 禁 write），不影响主 Agent
- 需确保 GuardDecision 中的 `traceStep` 被记录到审计日志

**验证**：
- 主 Agent 行为不变（topology = 'main'，无额外限制）
- 子 Agent 新增 topology 限制生效
- Hook-based 权限能通过 GuardFabric 参与决策
- `npm run typecheck` + 权限相关测试

### 2.2 LightMemory refresh-on-read（1-2h）

**现状**：
- `memories` 表有 `lastAccessedAt` 和 `accessCount` 字段但**从未用于任何逻辑**
- Entity Relations 已有 30 天半衰期指数衰减（read-time decay），设计合理
- LightMemory（文件系统）无衰减机制

**改动范围**：

| 步骤 | 文件 | 操作 |
|------|------|------|
| 1 | `src/main/lightMemory/memoryReadTool.ts` | 读取记忆时更新 `lastAccessedAt` 和 `accessCount++` |
| 2 | `src/main/services/core/repositories/MemoryRepository.ts` | 新增 `touchMemory(id)` 方法 |
| 3 | `MemoryRepository.ts` | 查询时对 `memories` 表也应用 read-time decay（参考 Entity Relations 的实现） |
| 4 | `src/shared/constants/storage.ts` | 新增 `MEMORY.RECORD_DECAY_DAYS: 90`（记忆条目半衰期，比 Relations 的 30 天更长） |

**设计**：
- 读取时 touch（refresh-on-read）→ 常用记忆保持活跃
- 查询时 decay（read-time）→ 久未访问的记忆信心下降
- 不删数据，只降权重 → 与 Entity Relations 一致

**验证**：手动写入记忆 → 读取 → 确认 `lastAccessedAt` 更新 → 确认旧记忆查询时信心值下降。

---

## Phase 3: 新能力建设

### 3.1 macOS Seatbelt 沙箱（1-2d）

**动机**：Anthropic 数据显示引入 OS 沙箱后权限弹窗减少 84%，安全性提升（用户不再盲目批准）。

**方案**：

```
src-tauri/
└── sandbox/
    ├── seatbelt-profile.sb    ← Seatbelt sandbox profile
    └── sandbox.rs             ← Rust FFI 启动沙箱子进程
```

| 步骤 | 操作 |
|------|------|
| 1 | 编写 Seatbelt profile（`.sb` 文件），限制：文件系统只读写工作目录 + `~/Library/Application Support/code-agent/`；网络白名单（API endpoints） |
| 2 | Rust 侧通过 `sandbox-exec` 启动 Node.js webServer 子进程（Tauri sidecar 改造） |
| 3 | 配置项 `sandboxEnabled: boolean`（默认 false，渐进启用） |
| 4 | 工具层适配：沙箱模式下 bash 工具的文件系统访问受限，需要清晰的错误提示 |
| 5 | 与 GuardFabric 集成：沙箱模式下部分权限检查可简化（OS 已保障） |

**参考**：Claude Code 的 Seatbelt profile + Bubblewrap 实现。

**验证**：
- 沙箱内：读写工作目录正常，bash `ls /` 受限
- 沙箱外（`sandboxEnabled: false`）：行为不变

### 3.2 Repo Map — tree-sitter AST 索引（1-2d）

**动机**：大仓库场景下，每次都用 grep/glob 动态发现代码结构效率低。Aider 的 Repo Map 用 ~1K tokens 展示整个仓库的类名、函数签名，显著提升上下文利用率。

**方案**：

```
src/main/context/
└── repoMap/
    ├── repoMapBuilder.ts    ← tree-sitter 解析 AST → 结构索引
    ├── repoMapRanker.ts     ← 图排序（文件为节点，依赖为边）选择相关片段
    ├── repoMapCache.ts      ← 文件变更增量更新（watch + git diff）
    └── types.ts             ← RepoMapEntry, DependencyGraph
```

| 步骤 | 操作 |
|------|------|
| 1 | 集成 `tree-sitter`（WASM 版，支持 TS/JS/Python/Rust/Go） |
| 2 | `repoMapBuilder`：遍历项目文件 → 解析 AST → 提取类名、函数签名、导出符号 |
| 3 | `repoMapRanker`：基于 import/require 关系构建依赖图 → PageRank 排序 → 选取 top-N 相关文件 |
| 4 | `repoMapCache`：监听文件变更 → 增量重建索引 → 缓存到 `~/.code-agent/cache/repo-map/` |
| 5 | 注入上下文：`contextAssembly.ts` 中在 system prompt 之后、chat history 之前注入 Repo Map |
| 6 | Token 预算：Repo Map 占用 ~1K-2K tokens，由 ProjectionEngine 管理 |

**参考**：Aider 的 `RepoMap` 实现 + `aider/repomap.py`。

**验证**：
- 打开一个 TS 项目 → Repo Map 生成正确的类名/函数签名
- 编辑文件 → 增量更新索引
- 对话中模型能引用 Repo Map 中的符号定位代码

---

## 依赖关系

```
Phase 1 (无依赖，可并行)
  ├─ 1.1 移除 generationId
  └─ 1.2 CommandMonitor 合并

Phase 2 (依赖 Phase 1 完成)
  ├─ 2.1 GuardFabric 接入 ← 依赖 1.2（CommandSafety 稳定后再改权限路径）
  └─ 2.2 LightMemory refresh-on-read（独立）

Phase 3 (独立于 Phase 1/2，可随时开始设计)
  ├─ 3.1 OS 沙箱 ← 与 2.1 GuardFabric 有集成点（沙箱简化权限检查）
  └─ 3.2 Repo Map（完全独立）
```

## 总工作量估算

| Phase | 项目 | 预估 | 风险 |
|-------|------|------|------|
| 1.1 | generationId 清理 | 30 min | 低（机械性移除） |
| 1.2 | CommandMonitor 合并 | 1h | 低（合并正则） |
| 2.1 | GuardFabric 接入 | 3-4h | 中（权限路径变更，需充分测试） |
| 2.2 | LightMemory refresh-on-read | 1-2h | 低（利用已有字段） |
| 3.1 | macOS Seatbelt 沙箱 | 1-2d | 高（OS 级，需调试 profile 权限） |
| 3.2 | Repo Map | 1-2d | 中（tree-sitter WASM 集成） |
