# D2 Phase 3b Skip Decision — Pi 借鉴 ⑤ D2 路径关账

决策日期: 2026-05-28
决策者: Claude (Linchen) + Codex (独立二次评估)
verdict: **关闭 D2 系列,不做 Phase 3b 也不急做 Phase 3c**

## 背景

Pi 借鉴 ⑤ D2 中庸路径目标:把 `plugins/` + `skills/` 抽象成单一 `ExtensionRegistry`。

已完成 (全部已合 main):
- PR #179 D2 Phase 1 — 公共 ExtensionMetadata + 投影 adapter
- PR #180 D2 Phase 2 — ExtensionRegistry skeleton(只读聚合视图)
- PR #181 rename ExtensionSource → ExtensionOrigin(前置清理)
- PR #182 D2 Phase 3a — AgentExtension.runtimeState + 首个消费方 `CapabilityRecommender` 迁移

原排期里的下一步 Phase 3b: 把 plugin lifecycle (`loadBuiltinPlugins` / `activatePlugin` / `deactivatePlugin` / `reloadPlugin` / hot-reload watcher) 迁到 `ExtensionRegistry`,旧 `PluginRegistry` 改 thin wrapper。

## Phase 3b 调研发现

### PluginRegistry 体量与消费面

| 维度 | 数值 |
|---|---|
| 代码量 | 829 行 |
| Builtin plugin | 7 个硬编码(image/audio/video/imageCreation/browserControl/computerUse/photoArchive) |
| Public 方法 | `getPlugins / getPlugin / initialize / activatePlugin / deactivatePlugin / reloadPlugin / shutdown / executeHooks (×4)` |
| 外部消费方 | 4 个独立文件 |
| Hot-reload | 完整 watcher + 500ms debounce + 3 场景处理 |

### 消费方分布

| 文件 | 调用面 | 性质 |
|---|---|---|
| `extension/extensionRegistry.ts` | `getPlugins()` | 已迁,只读 |
| `agent/runtime/contextAssembly/messageBuild.ts:400` | `getPlugins().filter(active && description)` | runtime 热路径,每 turn 读 |
| `services/plugins/extensionOpsService.ts` | `activate/deactivate/reload/getPlugin` | IPC handler |
| `plugins/index.ts` | barrel re-export | 路由 |

### 关键发现

- `PluginRegistry` lifecycle 已成熟,activate / deactivate / reload 路径都有 error 兜底
- `registeredTools` / `registeredHooks` 在 deactivate 时清空,无泄漏
- hot-reload watcher 处理了 new/removed/modified 三场景
- **无 bug 待修**

## Claude 的核心论据(初评估)

A. Pi ⑤ D2 blueprint 的"统一扩展形态"目标在 Phase 1-3a 已达成
B. Phase 3b 原计划(lifecycle 迁过来)不修任何 bug、不开任何新能力
C. lifecycle 归一的真正触发条件应该是"skill 也加 lifecycle 时"
D. 业务 ROI: PII 分支是用户价值,Phase 3b 是纯重构

推荐: 关闭 D2 系列。

## Codex 独立评估(全文)

Codex 在独立 context 下,read-only sandbox + 直接读源码,800 字内出 verdict。

### Verdict
AGREE 关闭 D2

### 论据评估
- **A: 立得住但有夸大**。统一读模型已成立: `ExtensionRegistry.getExtensions()` 加 `runtimeState`,且 `CapabilityRecommender` 已迁;但 `messageBuild` 热路径和 `extensionOpsService` 仍直读 `PluginRegistry`,所以**还不是统一运行时**。
- **B: 立得住**。`PluginRegistry` 现在同时管初始化、builtin 静态加载、PluginAPI、工具/Hook 注册、hot-reload、reload 错误路径。迁到 `ExtensionRegistry` 只会把**只读聚合层变成副作用 owner**,thin wrapper 不解锁能力。
- **C: 基本立得住**。skill 有安装/启停/发现 reload,但 `ParsedSkill` 没有和 plugin activate/deactivate 等价的 runtime lifecycle;现在 `parsedSkillToExtension` 固定 active,强行归一太早。
- **D: 立得住但只是优先级佐证**。真正技术理由是 3b 风险高、收益低,不是 PII 分支更重要。

### Claude 没看到的反对理由
1. **3b 会制造依赖反向压力**:当前 `ExtensionRegistry` 依赖 `PluginRegistry` 做投影;若 `PluginRegistry` 再 thin wrapper 到它,必须先拆新 core,否则容易循环依赖。
2. **marketplace / cloud sync / multi-agent 更需要统一 inventory、status、events**,不需要把 plugin activate 搬家。
3. **Phase 3a 没成半成品**;它是可用的读模型。技术债只在注释/路线图过时,不在运行结构。

### 推荐方向
- 关闭 D2,不做 Phase 3b,**也不急做 Phase 3c**。
- 后续只在具体产品需求触发时做小迁移:例如把 `messageBuild` 的 active plugin 描述改成读 `ExtensionRegistry`,或给 skill 增加明确 enable/runtime 语义后再谈归一。

## 最终决定

**关闭 D2 系列,不做 Phase 3b 也不做 Phase 3c**。

理由收敛(融合 Claude + Codex):
1. **Phase 3a 是可用读模型,不是半成品**。统一读模型已成立(`ExtensionRegistry.getExtensions()` + runtimeState),`CapabilityRecommender` 已迁。`messageBuild` 和 `extensionOpsService` 仍直读 PluginRegistry,但这是"读模型可用但未全迁",不是"读模型有漏洞"。
2. **Phase 3b 风险高、收益低**。把 ExtensionRegistry 从只读聚合层变成副作用 owner,需要先拆新 core 防循环依赖,且不解决任何已知 bug,不解锁任何用户能力。
3. **触发条件未达成**。lifecycle 归一应该等"skill 也加真 runtime lifecycle"或"marketplace/cloud sync 需要统一 inventory+status+events"时再谈,现在前置太早。
4. **未来真要做的不是 3b,是统一 inventory/status/events 层**。这是另一种设计,与 lifecycle 搬家无关。

## 后续触发条件(什么情况下重新打开 D2)

1. `messageBuild.ts:400` runtime 热路径需要包含 skill 信息(目前只读 plugin)时 → 改读 ExtensionRegistry,但不需要做 Phase 3b
2. Skill 增加 enable/disable runtime lifecycle 时 → 那时再谈 lifecycle 归一
3. marketplace / cloud sync / multi-agent 引入统一 inventory + events 需求时 → 走另一个 blueprint,不走 lifecycle 搬家

## 行动项

- ✅ Phase 3a 已合并入 main(PR #182)
- ✅ Codex 独立评估完成,verdict 一致
- ✅ 本决策文档归档(本文件)
- ⏭️ 清理 phase3b 调研 worktree
- ⏭️ 回 PII 分支(`feat/pii-one-click-setup`)继续业务工作
