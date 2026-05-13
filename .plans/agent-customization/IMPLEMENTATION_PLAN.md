# 用户自定义 Agent + 桌面端切换 UI — 实施计划

> 范围：让用户通过 `~/.code-agent/agents/*.md` 与 `<project>/.code-agent/agents/*.md` 落盘自定义 Agent，全链路（聊天 spawn / Task 工具 / @mention / CLI / 状态栏切换）能感知并热加载。
> 路径前缀均为绝对路径，便于落地审查。

---

## 1. 目标与非目标

**目标**
- 用户可在 `~/.code-agent/agents/<name>.md` 或工程目录 `<cwd>/.code-agent/agents/<name>.md` 用 Claude Code 兼容的 YAML frontmatter + Markdown 正文定义 agent，启动即生效。
- spawn_agent / Task 工具 / @mention 路由 / CLI `list-agents` / StatusBar Agent Switcher **统一**消费同一份 agent registry（builtin ∪ user ∪ project，project 覆盖 user，user 覆盖 builtin 同名）。
- 配置文件改动后 200ms 内通过 chokidar 热加载，**不打断** in-flight 子 agent。
- StatusBar 提供下拉切换 UI，沿用 `ModelSwitcher` 范式，确认后下一轮 spawn 默认走选中 agent。

**非目标**
- 不引入 sandbox / 权限审批/ 跨设备同步（沿用现有 SecurityProfile + permissionPreset 即可）。
- 不重写 spawnAgent 业务逻辑，只在入口加一层 registry 解析。
- 不删旧 `multiagentTools/spawnAgent.ts`，等待 Wave 4 重构。

---

## 2. 验收标准（必须全部满足）

1. **加载**：放置 `~/.code-agent/agents/foo.md` 并启动应用，`getAgent('foo')` 立即返回对应 config（含 prompt、tools、model）。
2. **覆盖**：project 目录与 user 目录同名 `foo.md` 共存时，`getAgent('foo')` 取 project；builtin `coder.md` 被用户级覆盖时，仍可通过 `getBuiltinAgent('coder')` 回到原始定义。
3. **热加载**：运行中编辑 `foo.md` 并保存，2 秒内 `getAgent('foo')` 拿到新配置；同时若有 in-flight spawn 正在跑，其拿到的 config 保持本轮快照不变。
4. **spawn 端到端**：`spawn_agent({role:'foo', task:'...'})` 能成功执行，使用 foo.md 的 prompt + tools，错误信息列出包含 'foo' 的最新可用 ID 集。
5. **CLI**：`code-agent list-agents` 输出含自定义 agent，标记 `source: 'user' | 'project' | 'builtin'`。
6. **@mention**：ChatInput `@foo` 自动补全可见，触发后路由到 foo agent。
7. **UI 切换**：StatusBar 下拉显示分组（Builtin / Custom），切换即生效，刷新页面后选择持久化。

---

## 3. 现状调研（已逐项核实）

| 现状条目 | 任务给出的描述 | 真实结果 | 修正 |
|---|---|---|---|
| coreAgents.ts 硬编码 5 个 agent | ✓ | `CORE_AGENT_IDS = ['coder','reviewer','explore','plan','awaiter']`（coreAgents.ts:64） | 一致 |
| `loadCustomAgents` 写好但零调用 | ✓ | `coreAgents.ts:542` 有定义，`hybrid/index.ts:33` 仅 re-export；全仓内除自身定义 + barrel re-export + `getCustomAgentCache` 外，**没有任何 caller** | 确认 |
| `agentMdLoader.ts` 已存在 | 路径错 | 实际位于 `src/main/agent/hybrid/agentMdLoader.ts`（不在 `src/main/agent/`） | 修正路径 |
| 两份 spawnAgent.ts，前者死代码 | ❌ | `modules/multiagent/spawnAgent.ts`（166 行）是 **新协议入口**，它 `import { executeSpawnAgent as executeSpawnAgentLegacy }` 调用 `agent/multiagentTools/spawnAgent.ts`（816 行）；两者都活跃 | 修正：166 行是 Wave 3 ToolModule 包装层，816 行是业务实现层，**dynamic agent 走两者** |
| getAgentsMdDir 存在 | ✓ | `configPaths.ts:162`，返回 `{ user: <user>/.code-agent/agents, project?: <cwd>/.code-agent/agents }` | 一致 |
| CLI 路径 `src/main/cli/listAgents.ts` | ❌ | 实际在 `src/cli/commands/listAgents.ts`（src/main/cli 目录不存在） | 修正 |
| spawnAgent 通过 `getAgent` 拿配置 | ❌ | 多agentTools/spawnAgent.ts L124 通过 `getPredefinedAgent(role)` 拿 ——后者来自 `agentDefinition.ts:118`，依赖 `PREDEFINED_AGENTS`（agentDefinition.ts:105），后者是 **CORE_AGENT_IDS 模块加载期 Object.fromEntries 出的常量**。任务工具 `tools/modules/multiagent/task.ts:205` 同样路径 | **关键**：即使现在调用了 `loadCustomAgents()`，spawn 路径根本看不到自定义 agent。必须替换 `getPredefinedAgent` 为新的 `resolveAgent(id)` 才能让自定义 agent 生效 |
| AgentTeamPanel 是消息 panel 非切换 UI | ✓ | `features/agentTeam/AgentTeamPanel.tsx` 是 swarm 消息流 | 一致 |
| ModelSwitcher 范式可抄 | ✓ | `components/StatusBar/ModelSwitcher.tsx` 现成 dropdown + Portal + 健康灯 | 一致 |
| chokidar 已可用 | 未提 | `package.json:112` `"chokidar": "^5.0.0"` | 可直接用 |

---

## 4. 设计方案

### 4.1 配置文件格式（Claude Code 兼容子集 + 本地扩展）

```markdown
---
name: porsche-coupon
description: 保时捷卡券领域专家，懂 ss-backend 和 OMP 配置
model: balanced
tools:
  - Read
  - Grep
  - Glob
  - Edit
  - Bash
max-iterations: 25
readonly: false
context-level: relevant
timeout: 120000
max-budget: 0.5
color: "#d4af37"
---

# 角色

你是保时捷数字化团队的卡券域工程师。

# 工作约束

- 涉及 mycat 的改动必须先 dump 当前 schema
- ss-backend 与 OMP 之间字段差异查 `docs/coupon/field-mapping.md`
- 所有 SQL 必须 EXPLAIN 后再执行
```

**字段语义**
- `name`（必填）：agent id，校验正则 `^[a-z][a-z0-9_-]{0,31}$`，不可与 builtin 冲突时**优先取 custom**。
- `description`（必填）：用于 @mention 列表 + spawn 错误信息 + 切换 UI 二级说明。
- `model`：`fast | balanced | powerful | inherit`（inherit = 跟随当前会话主模型）。
- `tools`：白名单数组，省略 = 继承父 agent 的全工具集（与 Claude Code 行为一致）。
- `readonly`：true 时强制剥夺所有写工具。
- `context-level`：`minimal | relevant | full`，对接 `subagentContextBuilder.ts`。

正文（frontmatter 后的 Markdown）= system prompt body，会自动追加对应 `SUBAGENT_SUFFIXES`（除非 frontmatter 指定 `suffix: none`，作为本地扩展）。

### 4.2 加载与热加载机制（核心：double-buffer）

```text
启动时：
  initBackgroundServices.ts
    └─ initAgentRegistry(workingDir)
         ├─ scanDir(user) ─┐
         ├─ scanDir(project) ─┴─→ buildMap()  // 新 Map
         └─ atomicSwap(newMap)                // 整体替换 customAgentCache 指针

运行时：
  chokidar.watch([user, project], { ignoreInitial: true })
    on('add'|'change'|'unlink')
      └─ debounce(200ms)
           └─ rescanAll()
                ├─ buildMap() // 不修改旧 cache
                └─ atomicSwap(newMap)

读取时：
  resolveAgent(id):
    const snapshot = customAgentCache  // 取当前指针快照
    if (snapshot?.has(id)) return snapshot.get(id)
    if (isCoreAgent(id)) return CORE_AGENTS[id]
    return undefined
```

**为什么必须 double-buffer**：当前 `loadCustomAgents()` 是 `customAgentCache = new Map(); for (...) cache.set(...)`，**在 set 过程中**如果有 in-flight spawn 调 `getAgent(id)`，就有可能拿到空 Map 或半填充的 Map。改造后做法：
1. 局部变量 `nextMap = new Map()` 构造新 cache。
2. 全部填充完成后**一行赋值** `customAgentCache = nextMap`，JS 引用赋值是原子的。
3. 任何 in-flight 调用要么看到旧 Map（完整），要么看到新 Map（完整），永远不会看到半成品。
4. 进一步：spawn 启动时把 `customAgentCache` 引用 capture 到本地常量 `const snapshot = customAgentCache`，保证整个 spawn 生命周期看到的是 capture 时刻的 agent config（即使中途热加载也用旧的，避免 prompt / tools 中途切换）。

### 4.3 与 PREDEFINED_AGENTS 的合并

新增 `src/main/agent/agentRegistry.ts`（单一真理源），暴露：
```typescript
export function resolveAgent(id: string): FullAgentConfig | undefined
export function listAllAgents(): Array<{ id, name, description, source: 'builtin'|'user'|'project' }>
export function isKnownAgent(id: string): boolean
export function initAgentRegistry(workingDir?: string): Promise<void>
export function disposeAgentRegistry(): Promise<void>
```

`PREDEFINED_AGENTS` 保留但**只服务内部 builtin 查询**；上层全部走 `resolveAgent`。`isCoreAgent` 重命名为 `isBuiltinAgent`，避免和 `isKnownAgent` 混淆。

合并策略：**project > user > builtin**，同名后者被前者覆盖。`source` 字段保留供 UI 显示徽标。

### 4.4 切换 UI（StatusBar Agent Switcher）

抄 `ModelSwitcher.tsx` 范式，新建 `src/renderer/components/StatusBar/AgentSwitcher.tsx`：

```
┌─ StatusBar 右侧 ──────────────────────────────┐
│  ... ModelSwitcher  │  🤖 coder ▾  │  ...    │
└──────────────────────────────────────────────┘
            点击后弹出 Portal：
┌──── Agent ─────────────────────────────────┐
│  搜索: [_________________]                  │
│ ─ Builtin ─────────────────────────────── │
│  ● coder       Coding subagent             │
│    reviewer    Read-only reviewer          │
│    explore     Research                    │
│    plan        Planning                    │
│    awaiter     Long-running watcher        │
│ ─ Custom (user) ──────────────────────── │
│    porsche-coupon  保时捷卡券域专家  [user] │
│ ─ Custom (project) ───────────────────── │
│    coda-fixer  本项目 bug 修复手  [project]│
└────────────────────────────────────────────┘
```

- 当前选中状态写入 `useAppStore.activeAgentId`（持久化到 localStorage）。
- 触发 IPC `agents:list` 拿全量 + source，订阅 `agents:changed` 推送做实时刷新。
- 空 agent 列表（无自定义）时只显示 builtin 区。
- 选中后下一轮聊天默认 `spawn_agent({role: activeAgentId})`，**当前轮 in-flight 不变**。

---

## 5. 文件改动清单（绝对路径）

**新增**
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/agentRegistry.ts` — 注册中心 + 热加载 watcher
- `/Users/linchen/Downloads/ai/code-agent/src/main/ipc/agentRegistryHandlers.ts` — 暴露 `agents:list` / `agents:changed`
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/components/StatusBar/AgentSwitcher.tsx` — UI
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/stores/agentRegistryStore.ts` — 渲染端缓存 + IPC 订阅
- `/Users/linchen/Downloads/ai/code-agent/tests/agentRegistry/concurrentReload.test.ts` — 并发热加载竞态测试

**修改**
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/hybrid/coreAgents.ts` — 移除内部 `customAgentCache`，转用 agentRegistry；`getAgent()` 改成代理调用
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/hybrid/agentMdLoader.ts` — `parseAgentMd` 增加 `source`、`color` 字段
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/agentDefinition.ts` — `getPredefinedAgent` 内部改走 `resolveAgent`，找不到再回 builtin；`listPredefinedAgents` → `listAllAgents`
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/multiagentTools/spawnAgent.ts` — L124 错误信息改用 `listAllAgents`，避免暴露过期 builtin-only ID
- `/Users/linchen/Downloads/ai/code-agent/src/main/tools/modules/multiagent/task.ts` — L205 同步改造
- `/Users/linchen/Downloads/ai/code-agent/src/main/app/initBackgroundServices.ts` — 启动时调 `initAgentRegistry(workingDir)`，app quit 时 `disposeAgentRegistry()`
- `/Users/linchen/Downloads/ai/code-agent/src/cli/commands/listAgents.ts` — 改用 `listAllAgents()`，多列 `source`
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/components/features/chat/ChatInput/index.tsx` — autocomplete 数据源换成 `agentRegistryStore`
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/components/StatusBar/index.tsx` — 嵌入 `<AgentSwitcher />`

---

## 6. 实施步骤（拓扑顺序）

**Step 1 · 注册中心骨架**（依赖：无）
1. 新建 `agentRegistry.ts`，把现有 `customAgentCache` 逻辑搬过来并改造成 double-buffer。
2. 内部用 `currentMap: Map | null`，导出 `resolveAgent`/`listAllAgents`/`isKnownAgent`。
3. 单测：构造两份 Map 交叉读取，验证 atomic swap。

**Step 2 · 接上 dynamicAgentFactory / PREDEFINED_AGENTS**（依赖：Step 1）
1. `agentDefinition.ts:118` 改造 `getPredefinedAgent`：`return resolveAgent(id) ?? throw`。
2. `coreAgents.ts:452 getAgent` 改成 `resolveAgent` 的薄包装，旧 `customAgentCache` 删除。
3. `dynamicAgentFactory.ts` 中 `createAgentFromDefinition` 暂不动（已支持任意 prompt/tools，custom agent 进 spawn 后会被 buildLegacyCtxFromProtocol 转成 DynamicAgentConfig 跑），但需要将自定义 prompt 路径接通——通过 `spawnAgent.ts:134` 中 `getAgentPrompt(agentConfig)` 已能取到正文。**关键接线**：让 `spawnAgent` 的 `getPredefinedAgent` 返回值能携带 custom prompt，而不是只取 builtin。

**Step 3 · 启动扫描 + chokidar**（依赖：Step 1）
1. `initAgentRegistry(workingDir)`：先扫 user 目录、再扫 project 目录、构建 nextMap、atomic swap。
2. 启动 chokidar watcher，监听两个目录，`add|change|unlink` 走 debounce 200ms → 全量重扫 → atomic swap。
3. 接 `initBackgroundServices.ts` 的 Phase 2，确保在 webServer 启动之前完成首次扫描。

**Step 4 · IPC 暴露**（依赖：Step 1）
1. 新增 `agents:list` handler 返回 `listAllAgents()`。
2. 新增 `agents:changed` 推送通道（broadcast 给所有 BrowserWindow）。
3. 热加载完成后从 agentRegistry 发出事件，IPC handler 转发到 renderer。

**Step 5 · CLI**（依赖：Step 1）
1. `src/cli/commands/listAgents.ts` 改用动态 import `agentRegistry`。
2. CLI 启动时也需要先 `initAgentRegistry(process.cwd())`（CLI 是独立进程）。
3. JSON 输出新增 `source` 字段。

**Step 6 · ChatInput @mention**（依赖：Step 4）
1. `agentMentionRouting.ts` 不变（已经是纯函数）。
2. ChatInput 数据源从 hardcoded 切换到 `agentRegistryStore`。

**Step 7 · StatusBar AgentSwitcher**（依赖：Step 4）
1. 抄 `ModelSwitcher.tsx` 骨架，做 Portal dropdown。
2. 接 `agentRegistryStore`，持久化 `activeAgentId`。
3. spawn 时如果用户没 @mention 则把 `activeAgentId` 注入 default role。

**Step 8 · 测试 + 文档**（依赖：所有）
1. 并发热加载测试（详见 §8）。
2. 写 `docs/guides/custom-agents.md` 一节给最终用户。
3. 在 `~/.code-agent/agents/example.md` 放一份 sample（首启动 lazy seed）。

---

## 7. 风险与缓解

**R1 · 热加载竞态（最高风险）**
in-flight `spawn_agent` 读到半填充 Map，导致 tools 为空或 prompt 拼接错乱。
*缓解*：double-buffer atomic swap（§4.2），并在 spawn 入口 `const snapshot = customAgentCache` capture 一次，整个 spawn 生命周期内不再重读。getAgent 永远兜底回 builtin，杜绝返回 undefined。并发测试用 100 并发 + 200ms 间隔 reload 拟合。

**R2 · 自定义 agent 与 builtin 同名覆盖污染**
用户写一个 `coder.md` 把内置 coder 整坏，影响所有依赖 coder 的内部流程（如 agentLoop 主链路）。
*缓解*：保留 `getBuiltinAgent(id)` 拿原始 builtin；agentLoop 主链路调用 `getBuiltinAgent('coder')` 而不是 `resolveAgent('coder')`；只有用户显式 `spawn_agent({role:'coder'})` 才走 resolveAgent。文档说明此规则。

**R3 · CLI 与桌面端 registry 不一致**
两个进程各自扫描，user 目录共享，project 目录如果传入不同 workingDir 则不一致。
*缓解*：CLI 启动时强制 `initAgentRegistry(process.cwd())`；输出加 `--working-dir` 参数；JSON 标注 source 让用户感知。

**R4 · YAML mini-parser 解析失败静默**
`agentMdLoader.ts` 的 `parseSimpleYaml` 是简化版，遇到嵌套结构或转义可能解析错，但 `loadAgentMdFiles` 当前 try/catch 吞掉错误。
*缓解*：解析失败记结构化日志 + IPC 推送到 renderer 显示 toast；toast 复用 ConfigService 的报警通道。

**R5 · @mention 自动补全卡顿**
大量自定义 agent + 渲染端搜索做全量 filter 会卡。
*缓解*：mention list 来自 store 缓存（不发 IPC），过滤本地做；超过 50 个时 virtualize。

---

## 8. 测试计划

**单元**
- `agentRegistry.test.ts`：parse + merge + override 三档优先级。
- `agentMdLoader.test.ts`：补 edge case（无 frontmatter / 空 tools 数组 / 非法 model 值）。

**并发热加载竞态（核心）**
- `concurrentReload.test.ts`：
  ```
  for i in 1..100:
    fire async resolveAgent('foo')   // 100 并发读
  parallel:
    每 50ms 触发一次 atomicSwap(newMap)   // 模拟 chokidar
  断言：100 次读取全部返回非空、字段完整的 config
  ```

**集成**
- 把测试 agent `tests/fixtures/agents/test-agent.md` 放进 user 目录 → 跑 `spawn_agent({role:'test-agent'})` → 验证 prompt 含测试 agent 正文 + 后缀。
- 手工编辑 `test-agent.md` 改 prompt → 等 1 秒 → 再 spawn → 验证拿到新版本。

**端到端**
- E2E Playwright 脚本：启动桌面端 → 点 AgentSwitcher → 选 `test-agent` → 发 `@<task>` → 抓 spawn IPC 帧验证 role。
- CLI 冒烟：`code-agent list-agents | jq '.[] | select(.source != "builtin")'` 应返回测试 agent。

**回归**
- 启动后台 spawn coder/reviewer/explore/plan/awaiter 五个 builtin，确保无回归。
- typecheck + 现有 hybrid 测试套件全绿。

---

## 9. 工作量估算

| Step | 描述 | 工时 |
|---|---|---|
| 1 | agentRegistry 骨架 + double-buffer | 4h |
| 2 | 接 PREDEFINED_AGENTS / coreAgents.getAgent | 3h |
| 3 | initBackgroundServices 接入 + chokidar | 3h |
| 4 | IPC `agents:list` / `agents:changed` | 2h |
| 5 | CLI listAgents 改造 | 1.5h |
| 6 | ChatInput @mention 切换数据源 | 1.5h |
| 7 | StatusBar AgentSwitcher UI | 6h |
| 8 | 单测 + 并发热加载测试 + E2E | 5h |
| — | typecheck / 文档 / 风险复盘 | 2h |
| **合计** | — | **28h（约 4 个工作日）** |

---

## 附录 · 上游格式参考

Claude Code 官方 `.claude/agents/<name>.md` 格式（2026-Q1）：
- 必填：`name` / `description`
- 可选：`tools`（省略 = 继承父）、`model`（含 `inherit`）、`disallowedTools`、`maxTurns`、`color`
- 正文：Markdown，自动作为 system prompt body

本计划对齐上述子集，仅在本地扩展 `max-iterations` / `context-level` / `timeout` / `max-budget` / `readonly` 五个字段（agentMdLoader.ts 已支持），保持向 Claude Code 单向兼容。
