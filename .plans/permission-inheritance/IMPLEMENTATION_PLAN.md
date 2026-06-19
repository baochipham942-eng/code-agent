# Subagent 权限继承 + Deny Rules 级联 — 实施计划

> **状态**：草案 v1（2026-05-13，产品负责人）
> **范围**：M2-Task 5 partial — 仅做 `parentContext` 注入 + 用户 deny 规则级联，AgentTask/profile profile-matrix 留待 M2-Task 5 full。
> **风险灯**：🟢 绿（已是设计完整的方案，只是 4 月 1 日 M2-Task 5 没收口）。
> **优先级**：P0 — code-agent 当前最重要的差异化安全特性，关系到 plan→build / reviewer→coder / CI 子代理 三大工作流的承诺。

---

## 1. 目标 & 非目标

### 目标

1. **接通存量零调用模块**：让 `SubAgentPermissionManager` / `buildChildContext` / `denyRules.addDenyRule` / `PolicyEngine.loadUserRules` 真正进入 spawn 路径。
2. **三档模式语义化**：把"权限继承"做成可配置的 `strict-inherit` / `child-narrow` / `independent` 三档，让用户的 plan→coder、reviewer→coder、CI subagent 工作流真的安全。
3. **deny 级联**：父 agent 的 deny 规则必须传递到所有 subagent，子 agent 只能在父集合上再"窄化"（contract），永远不能扩张（escalate）。
4. **闭合四个真实漏洞场景**（A/B/C/D，见 §5）。
5. **GuardFabric 单一仲裁**：所有 spawn 路径走 `getGuardFabric().evaluate()`，不绕过。

### 非目标

- ❌ **不做 profile-matrix 全集**：M2-Task 5 原计划同时接 profile + AgentTask 协议 + childContext，本计划只锁 `parentContext`。commit message 必须明说 "M2-Task 5 partial — childContext only, AgentTask/profile pending"。
- ❌ **不重写 GuardFabric**：保持 `deny > ask > allow, first-valid-wins` 语义不动，只新增一个 source（`UserConfigSource`）。
- ❌ **不动 permissionPreset 体系**：`development/production/review/audit` 四档不删；新三档是**正交维度**（继承策略），不是替换 preset。
- ❌ **不引入新的 IPC 命令**：settings UI 复用 `update_settings`。

---

## 2. 验收标准

1. **AC-1（场景 A）**：开启 `permissions.inheritance = "strict-inherit"`，主 agent 处于 `plan` 模式时，subagent（任意 role/preset）**不能**调用 `write/edit/bash` 写工具。e2e：plan→coder 子代理收到 task `修改 src/foo.ts`，必须返回 `permission denied`。
2. **AC-2（场景 B）**：用户 `settings.json` 写 `permissions.deny: ["Bash(rm -rf *)", "Write(/etc/*)"]`，主 agent 和 subagent **全部**收到该 deny。e2e：spawn explorer subagent 让它 `bash rm -rf /tmp/test`，必须 deny。
3. **AC-3（场景 C）**：CI 模式（`permissionPreset = 'ci'` 或 env `CI=1`）主 agent 的 deny 集合，subagent **自动继承**。e2e：CI 主 agent deny 了 `Network(*)`，subagent 调 `web_fetch` 必须 deny。
4. **AC-4（场景 D）**：reviewer subagent（任意配置）**禁止** spawn 出 `coder`/任何带 write 能力的子 agent。e2e：reviewer 内部调 `spawn_agent role=coder`，返回 `PERMISSION_DENIED reason="reviewer 不能派生写工作流"`。
5. **AC-5（回归不破坏）**：没有 parentContext 的旧 caller（外部 CLI 直接调 `getSubagentExecutor`）仍能跑，行为不变（fallback 到现有逻辑）。
6. **AC-6（合并算法正确性）**：子 tools = parent tools ∩ child declared；deny = parent deny ∪ child deny；mode 取更严格者。三条独立 unit test。

---

## 3. 现状调研（已验证）

### 3.1 五大零调用模块（grep 验证）

| 模块 | 路径:行 | 业务 caller |
|---|---|---|
| `SubAgentPermissionManager` | `src/main/agent/permissions.ts:139` | **0**（仅 barrel re-export at `agent/index.ts:47-51`） |
| `PolicyEngine.loadUserRules` | `src/main/permissions/policyEngine.ts:385` | **0** |
| `denyRules.addDenyRule` | `src/main/tools/dispatch/denyRules.ts:31` | **0**（仅 registry.ts:5 / protocol/tools.ts:282 注释提及） |
| `buildChildContext` | `src/main/agent/childContext.ts:37` | 1（subagentExecutor.ts:484，但走 `if (context.parentContext)` 分支） |
| `subagentExecutor.parentContext` 字段 | `src/main/agent/subagentExecutor.ts:149` | **0 caller 实际传值** |

### 3.2 两份 spawnAgent.ts 的真实关系（grep + read 验证）

| 文件 | 行数 | 角色 |
|---|---|---|
| `src/main/tools/modules/multiagent/spawnAgent.ts` | 166 | ToolModule 协议包装（schema + handler）。**透传给 legacy。** |
| `src/main/agent/multiagentTools/spawnAgent.ts` | 816 | **真实业务实现**。`executeSpawnAgent` 函数。executorContext 构造在 L270。 |

→ **改动锚点确认在第二份 L270 的 `executorContext` 对象字面量**，第一份不需要动。

### 3.3 GuardFabric 现状

- `permissions.ts:343` 已经调 `getGuardFabric().evaluate()`，**但 SubAgentPermissionManager 整个类没人 call**，所以这条路径死代码。
- GuardFabric 的 source 列表当前只在 `permissions/index.ts` 注册 `HookGuardSource`。**没有 UserConfigSource**——这就是为什么 settings.json 的 deny 字段（设计上还没有）无法生效。
- `TOPOLOGY_RULES`（guardFabric.ts:54）已有 `bash: { async_agent: 'deny', coordinator: 'deny' }` 兜底，但这只对 `executionMode=autonomous/supervised` 生效，普通 spawn_agent 走 default `main`，不触发。

### 3.4 subagentExecutor 有 10+ caller

`task.ts` / `skill.ts` / `explore.ts` / `workflowOrchestrate.ts` / `DAGScheduler.ts` / `autoAgentCoordinator.ts` / `parallelAgentCoordinator.ts` / `coworkOrchestrator.ts` / `spawnAgent.ts` / `worktree-tasks` 都 call `getSubagentExecutor().execute(...)`。**每一个都得改**，否则没有 parentContext 传入，新机制只对 spawnAgent 一条路径生效。

### 3.5 M2-Task 5 停工证据

`docs/superpowers/plans/2026-04-01-m2-prompt-matrix-multiagent-runtime.md` L461 写了 Task 5。`git log --grep="M2-Task 5"` 返回空。Task 4（Mailbox `644c217e`）落地了，Task 5 没动。`subagentExecutor.ts:481-482` 的注释直说 "additive — if no parent context, existing logic unchanged"：作者留 fallback 等 caller。

---

## 4. 设计方案

### 4.1 三档模式定义

| 模式 | 语义 | 适用场景 |
|---|---|---|
| `strict-inherit` | 子 = 父的真子集。tools ∩、deny ∪、mode 取更严。**永不扩张。** | **默认**。plan→coder、reviewer→audit、CI subagent |
| `child-narrow` | 子在父集合内可声明更窄能力（子 deny ⊇ 父 deny + 自己额外 deny）。但允许 child 在父允许的 deny 列表上额外放宽（即父 ask → 子 allow），**仅当父 mode 是 default 或 acceptEdits**。 | 显式协作场景：explorer 父派 fast-fixer 子 |
| `independent` | 子完全独立（仍受 GuardFabric topology + 用户 deny 规则约束，但不继承父 mode 和父 constraints）。 | **不推荐**。仅给 e2e 测试 fixture 或老 CLI grandfathering 用 |

### 4.2 默认模式选择 + 论据

**默认 `strict-inherit`**。三条理由：

1. **安全默认 > 便利默认**：code-agent 卖点是"AI 代理可信"。一旦默认 `independent`，场景 A/D 立刻塌方，用户在论坛上拍照截图。安全默认即使吃便利分，也好过事故。
2. **现有用户工作流已经默认这样以为**：plan-then-build skill 的 README 写"plan agent 是 readonly"——用户预期就是继承。改成 strict-inherit 是把"以为"落实为"是"。
3. **可演进**：strict-inherit 是最严，老 caller 切到 strict 顶多卡几个 explorer→fixer 场景（场景 B 用户会主动找文档），文档加一行"如需放宽用 child-narrow"即可恢复。反过来从 independent 收紧用户体感坏得多。

### 4.3 配置入口

`AppSettings.permissions` 扩展（`src/shared/contract/settings.ts:49-55`）：

```ts
permissions: {
  autoApprove: Record<PermissionLevel, boolean>;
  blockedCommands: string[];      // 历史字段，保留
  devModeAutoApprove: boolean;
  permissionMode?: PermissionMode;

  // ===== 新增 =====
  /** 子 agent 权限继承策略，默认 strict-inherit */
  inheritance?: 'strict-inherit' | 'child-narrow' | 'independent';
  /** 用户级 deny 规则（tool specifier 语法，复用 PolicyEngine.loadUserRules） */
  deny?: string[];
  /** 用户级 ask 规则 */
  ask?: string[];
  /** 用户级 allow 规则（最低优先级，不能压过 deny） */
  allow?: string[];
}
```

存储层在 `configService.ts` 现有 settings 持久化路径上自动跟上，**不需要新表**。

### 4.4 合并算法（伪代码）

```
mergeChildContext(parent: ParentContext, child: ChildContextConfig, mode: InheritanceMode): EffectiveContext {
  // 1. tools 交集（永不扩张）
  const toolPool = intersect(parent.availableTools, child.allowedTools);

  // 2. deny 并集（永远叠加）
  const denyRules = union(parent.deny, child.deny ?? []);

  // 3. mode 取更严
  let effectiveMode = moreRestrictive(parent.permissionMode, child.mode ?? 'default');

  // 4. 按 inheritance 模式裁剪
  if (mode === 'strict-inherit') {
    // 子的 ask/allow 必须是父的子集；非子集直接降为父的对应级
    child.ask = intersect(parent.ask, child.ask ?? parent.ask);
    child.allow = intersect(parent.allow, child.allow ?? parent.allow);
  } else if (mode === 'child-narrow') {
    // 子可以追加 deny，但 ask/allow 不能突破 GuardFabric topology + 用户 deny
    // 子可在父的 ask 范围内自行 allow（仅当父 mode ∈ {default, acceptEdits}）
    if (!['default', 'acceptEdits'].includes(parent.permissionMode)) {
      child.allow = intersect(parent.allow, child.allow ?? []);
    }
  } else {
    // independent：仅强制 user-level deny + topology
    effectiveMode = child.mode ?? 'default';
  }

  // 5. 场景 D 兜底：readonly role 不能 spawn write 能力的子
  if (parent.role in READONLY_ROLES && child.capabilities.includes('write')) {
    return DENY_RESULT('readonly role cannot spawn writer subagent');
  }

  return { toolPool, denyRules, effectiveMode, ask: child.ask, allow: child.allow };
}
```

### 4.5 GuardFabric 接入点

新增 `src/main/permissions/userConfigSource.ts`，实现 `GuardSource`：

```
class UserConfigSource implements GuardSource {
  name = 'user-config';
  evaluate(req: GuardRequest): GuardSourceResult | null {
    const policy = getPolicyEngine();
    const decision = policy.evaluate({ tool: req.tool, args: req.args, ... });
    return decision.action !== 'allow' ? { verdict, confidence: 0.9, source: 'user-config', reason } : null;
  }
}
```

在 `permissions/index.ts` 初始化时注册：

```
getGuardFabric().registerSource(new HookGuardSource());
getGuardFabric().registerSource(new UserConfigSource());  // 新增
```

启动钩子（`main.ts` 或现有 settings load 路径）：

```
const settings = await getAppSettings();
getPolicyEngine().loadUserRules({
  allow: settings.permissions.allow,
  deny: settings.permissions.deny,
  ask: settings.permissions.ask,
});
```

这一步**单线程做完**，避免 spawn 时再竞态加载。

### 4.6 spawnAgent.ts L270 改动

```diff
 const executorContext = {
   modelConfig: context.modelConfig as ModelConfig,
   toolResolver: context.resolver as ToolResolver,
   toolContext: { ...context, agentId },
   parentToolUseId: context.currentToolCallId,
   abortSignal: abortController.signal,
   spawnGuardId: agentId,
   executionAgentId: agentId,
   worktreePath: worktreeInfo?.worktreePath,
   hookManager: context.hookManager,
+  parentContext: {
+    rules: context.parentRules ?? [],
+    memory: context.parentMemory ?? [],
+    hooks: context.parentHooks ?? [],
+    skills: context.parentSkills ?? [],
+    mcpConnections: context.parentMcpConnections ?? [],
+    permissionMode: getPermissionModeManager().getMode(),
+    availableTools: context.parentAvailableTools ?? [],
+  } satisfies ParentContext,
 };
```

同时在 `subagentExecutor.ts:483-497` 把 fallback 分支删掉（保留 logger.warn），让 strict-inherit 是默认行为。

### 4.7 readonly role 工具强制收口

`spawnAgent.ts:220-225` 已有 `READONLY_ROLES` 过滤工具列表，但**只过滤工具不阻止 spawn 子**。新增：

```ts
const PARENT_ROLE = context.currentAgentRole;  // 已存在
if (READONLY_ROLES.includes(PARENT_ROLE) && WRITER_ROLES.includes(role)) {
  return { success: false, error: 'PERMISSION_DENIED: readonly role cannot spawn writer subagent' };
}
```

这是场景 D 的关键钩子。

---

## 5. 四个场景修复对照

### 场景 A — plan→build 工作流名存实亡

**漏洞**：plan agent（mode=plan、tools=readonly）spawn coder，coder 用自己 tools 集（含 write/edit/bash）绕过 readonly 约束。

**修复**：
- spawnAgent.ts L270 注入 parentContext，permissionMode='plan'。
- buildChildContext 取 toolPool = parent.tools ∩ child.declared，parent.tools 是 readonly 集合，交集后子 agent 也只有 readonly。
- 即便 child 声明 `[write, bash]`，交集后 `toolPool = []`，subagent 拿不到写工具。
- e2e：plan agent → spawn coder("修改 foo.ts") → 子 agent 实际 toolPool 为空 → 报错 `no available tools for this task`。

### 场景 B — 用户自定义 deny 失效

**漏洞**：settings.json 的 deny 只对主 agent 生效，subagent 不读。

**修复**：
- 启动时 `getPolicyEngine().loadUserRules(settings.permissions)` 写入全局 PolicyEngine。
- subagent 走 `evaluateSubAgentPermission`，内部调 `getGuardFabric().evaluate(...)`，UserConfigSource 命中 → deny。
- e2e：`settings.permissions.deny = ["Bash(rm -rf *)"]` → 重启 → spawn explorer → 调 bash `rm -rf /tmp/test` → deny。

### 场景 C — CI 模式 subagent 越权

**漏洞**：CI 主 agent 守规矩，spawn 的 subagent 不继承 CI deny。

**修复**：
- `permissionPresets.ts:103` 的 `ci` preset 内部 deny 列表（如 `Network(*)`）通过 parentContext 的 `blockedCommands` / `blockedLevels` 字段传下去。
- 在 `SubAgentPermissionManager.createConstraints` 已经写好 `blockedCommands` 并集逻辑（permissions.ts:194-195）——这套现有代码直接可用。
- e2e：CI 主 agent (`CI=1`) → spawn explorer → 调 web_fetch → deny。

### 场景 D — reviewer 派 coder 污染审查

**漏洞**：reviewer 顺手 spawn coder 改文件，违背"review 工作流 readonly"承诺。

**修复**：
- §4.7 的 `READONLY_ROLES × WRITER_ROLES` 黑名单矩阵，在 spawnAgent.ts 入口直接拒绝。
- 哪怕 user 设 inheritance=independent，这条仍然走（属于 topology hard rule，不通过 settings 关闭）。
- e2e：reviewer agent → spawn coder → 返回 PERMISSION_DENIED。

---

## 6. 文件改动清单

### 修改
- `/Users/linchen/Downloads/ai/code-agent/src/shared/contract/settings.ts` — `permissions` 新增 `inheritance` / `deny` / `ask` / `allow` 字段（§4.3）。
- `/Users/linchen/Downloads/ai/code-agent/src/main/services/core/configService.ts` — 启动 hook：load settings 后调 `PolicyEngine.loadUserRules`。
- `/Users/linchen/Downloads/ai/code-agent/src/main/permissions/index.ts` — 注册 `UserConfigSource` 到 GuardFabric。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/multiagentTools/spawnAgent.ts` L220-225 + L270 — 注入 parentContext；§4.7 readonly→writer 黑名单。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/subagentExecutor.ts` L478-497 — 移除 fallback 分支，强制走 buildChildContext；记一行 warn 给老 caller。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/childContext.ts` — buildChildContext 增加 inheritance 参数；扩展 ParentContext 加 `ask` / `allow` / `deny` / `blockedCommands` 字段。
- `/Users/linchen/Downloads/ai/code-agent/src/main/tools/modules/multiagent/task.ts` / `skill.ts` / `planning/explore.ts` 等 10+ caller — 在调 `getSubagentExecutor().execute(...)` 前组装 parentContext。**统一抽 `buildParentContextFromToolContext(ctx)` helper 放 childContext.ts**，避免散落硬编码。
- `/Users/linchen/Downloads/ai/code-agent/src/renderer/settings/PermissionsPanel.tsx`（或对应文件） — UI 暴露 inheritance / deny / allow / ask。

### 新增
- `/Users/linchen/Downloads/ai/code-agent/src/main/permissions/userConfigSource.ts` — UserConfigSource 实现 GuardSource。
- `/Users/linchen/Downloads/ai/code-agent/src/main/agent/__tests__/permissionInheritance.test.ts` — §4.4 合并算法 3 条 unit test。
- `/Users/linchen/Downloads/ai/code-agent/e2e/permission-inheritance/scenario-{a,b,c,d}.spec.ts` — 4 个 e2e。

### 删除
- 无（denyRules.ts 暂保留，因为 `filterToolsByDenyRules` 走的是 LLM tools 列表过滤路径，和 GuardFabric 不冲突；后续阶段再决定要不要合并）。

---

## 7. 实施步骤

| Phase | 内容 | 依赖 | 工时 |
|---|---|---|---|
| **P1** | Settings schema + configService loadUserRules + UserConfigSource 注册 | — | 0.5d |
| **P2** | childContext.ts 扩展 + 合并算法 + 3 条 unit test | P1 | 1d |
| **P3** | spawnAgent.ts L270 + L220 注入 parentContext + readonly→writer 黑名单 | P2 | 0.5d |
| **P4** | 抽 buildParentContextFromToolContext helper + 10+ caller 接线 | P3 | 1d |
| **P5** | 4 e2e + settings UI 暴露 inheritance/deny 字段 + 文档 | P4 | 1.5d |
| **P6** | typecheck + 全量 multiagent 回归 + 灰度开关 | P5 | 0.5d |

**总工时**：5 人天（中等不确定度，主要风险在 P4 caller 数量）。

---

## 8. 风险 & 缓解

### R1 — 默认 strict-inherit 让现有 plan→coder 工作流"看起来坏掉"

**症状**：用户 plan agent spawn coder，子 agent toolPool 为空，子 agent 报"无可用工具"。
**缓解**：
- 文档明示 plan agent 是 readonly，coder 应该在 plan 之后切到 default 模式重新 spawn（不是从 plan agent 内部 spawn）。
- 错误信息加诊断提示："plan mode 不能 spawn 写工作流；切回 default 后重试"。
- 提供一键诊断：右下角 toast "agent X 因继承策略被拒，点击查看说明"。

### R2 — 老 agent 配置 grandfathering

**症状**：用户原本用 explorer→fixer 这种"父 readonly、子 writer"模式（不该工作但侥幸工作），新机制后失败。
**缓解**：
- 新 settings 字段 `inheritance` 默认值 `strict-inherit`，但**在 settings 首次读到旧版且没有 inheritance 字段时**，标记 `_legacy=true`，弹一次性引导："强烈建议 strict，如必要切 child-narrow"。
- 不提供 `independent` 作为 grandfathering 默认——故意逼用户主动声明。
- 给 6.7.x → 6.8.x release notes 一段"安全升级说明"。

### R3 — GuardFabric 双裁决路径冲突

**症状**：UserConfigSource deny + permissionPreset deny 同时命中，最终 reason 串混乱。
**缓解**：
- GuardFabric 现有 `deny > ask > allow, first-valid-wins`，**保持不动**。
- UserConfigSource confidence=0.9，HookGuardSource confidence=0.8（既有），所以同级 deny 时 user-config 先入榜——reason 字段统一显示 `user-config: <pattern>`。
- 双源同时 deny 时 traceStep 必须记录 `allResults`（已实现），前端在异常 panel 展开显示，方便排查。

### R4 — 10+ caller 接线遗漏

**症状**：某条 spawn 路径没传 parentContext，新机制对它失效，子 agent 越权但不报错。
**缓解**：
- buildChildContext 的 fallback 改成 `throw new Error('parentContext required (M2-Task 5)')`，**而不是静默 fallback**。
- typecheck 强制：`SubagentContext.parentContext` 改成必填（去掉 `?`）。
- P4 起一个 grep 自检脚本：`grep -rn "getSubagentExecutor().execute" src/` 必须每一条 caller 都在 P4 清单内。

### R5 — PolicyEngine 启动竞态

**症状**：settings 还没 load 完，第一个 agent 已经 spawn，loadUserRules 没生效。
**缓解**：
- `getSubagentExecutor().execute` 入口加 `await ensureUserRulesLoaded()` 屏障（单次 promise，只 await 一次）。
- 启动顺序：configService load → loadUserRules → ready event → 任何 spawn UI 才解锁。

---

## 9. 测试计划

### Unit
- `permissionInheritance.test.ts` — 合并算法 3 条：tools 交集、deny 并集、mode 取严。
- `childContext.test.ts` — strict-inherit / child-narrow / independent 三档下 toolPool 与 deny 输出。
- `userConfigSource.test.ts` — UserConfigSource 命中 / miss / 转 GuardSourceResult。

### E2E（4 场景 × 正反双跑）

| 场景 | 正向（应 deny） | 反向（应 allow） |
|---|---|---|
| A plan→coder | plan agent spawn coder + 写文件 → deny | default agent spawn coder + 写文件 → allow |
| B 用户 deny | deny=`Bash(rm -rf*)`，subagent 调 `rm -rf` → deny | 同 deny，subagent 调 `ls -la` → allow |
| C CI 模式 | CI=1 主 agent → subagent web_fetch → deny | CI=0 主 agent → subagent web_fetch → allow |
| D reviewer 派 coder | reviewer spawn coder → deny | reviewer spawn explorer → allow |

### 回归
- 跑全量 multiagent test suite（workflowOrchestrate / DAGScheduler / parallelAgentCoordinator）。
- 手测 plan-then-build skill 完整链路。
- 手测 `npm run typecheck` + `npm run build` 必须过。

---

## 10. 工作量估算

| 维度 | 估算 |
|---|---|
| 代码改动 | ~600 行（含 e2e ~200 行） |
| 新增文件 | 3 个（userConfigSource.ts + 1 个 unit test + 4 个 e2e） |
| 修改文件 | ~13 个（含 10+ caller 接线） |
| 总工时 | **5 人天**（含联调 1d、e2e 1.5d、回归 0.5d） |
| 关键路径 | P3 → P4（caller 接线），P4 是最大不确定项 |
| 推荐节奏 | 单人连做 1 周；不要分两人并行 |

---

## 附录 A — 推荐默认模式

**`strict-inherit` 作为默认值**。理由见 §4.2，三条：
1. 安全默认 > 便利默认（差异化卖点）。
2. 用户已经"以为"是这样，把"以为"落实为"是"。
3. 可演进：从严到宽容易，从宽到严会引发回归。

**`child-narrow` 推荐给**：explorer→fixer、planner→coder（先 plan 后 build 跨 agent 阶段）等显式协作链路，用户在 spawn 时显式声明 `inheritanceOverride: 'child-narrow'`。

**`independent` 不推荐**，仅给 e2e fixture 与极少数老 CLI 模板，settings UI 上加红字"不推荐"提示。
