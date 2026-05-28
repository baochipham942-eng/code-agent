# Phase 3a Audit — D2 AgentExtension.runtimeState + CapabilityRecommender 迁移

审计时间: 2026-05-28
审计基线: 3479ec8b
审计目标: 2e75f435
审计员: Codex

## Verdict
PASS

## Findings

### HIGH (必须修)
- 无

### MEDIUM (建议修)
- 无

### LOW (可选)
- L1 CapabilityRecommender 迁到 ExtensionRegistry 后，候选插件的展示顺序从 PluginRegistry 插入顺序变成 ExtensionRegistry 的 source/id 排序。当前看不到功能错误，但这是一个可见输出顺序变化，测试没有把这个变化显式固定下来。
  - 文件: src/main/services/capability/CapabilityRecommender.ts:65
  - 文件: src/main/extension/extensionRegistry.ts:75
  - 文件: src/renderer/components/features/capability/GapCard.tsx:64
  - 现象描述: 旧实现直接扫 `getPluginRegistry().getPlugins()`，候选顺序继承 Map 插入顺序；新实现扫 `getExtensionRegistry().getExtensions()`，后者会按 `metadata.source` 和 `metadata.id` 排序。GapCard 和 recommend_capability 输出会按 candidates 顺序渲染插件名。
  - 风险后果: 多个候选插件同时匹配时，UI/LLM 看到的候选顺序可能和旧路径不同。如果旧顺序隐含 builtin 注册优先级或磁盘发现优先级，这里会变成静默行为变化。
  - 修复方向: 明确这个顺序变化是否是 Phase 3a 的有意语义；如果是，就补一个多候选顺序测试；如果不是，就在 CapabilityRecommender 的 plugin candidate 层保留旧插件顺序。
  - 置信度: medium

- L2 `source === 'builtin' || source === 'plugin'` 只能保证当前不误扫 skill，因为当前 skill metadata 没有 capabilities；它本身不能区分 plugin extension 和 builtin/plugin 来源的 skill。
  - 文件: src/main/services/capability/CapabilityRecommender.ts:63
  - 文件: src/main/extension/adapters.ts:72
  - 文件: tests/unit/extension/extensionRegistry.test.ts:139
  - 现象描述: `parsedSkillToMetadata` 当前不投影 capabilities，所以 skill 不会被 CapabilityRecommender 命中；但 ExtensionRegistry 已明确允许 skill source 为 `builtin` 或 `plugin`，与 plugin source filter 使用同一组字面量。
  - 风险后果: 当前没有运行时问题；风险在于注释写成“加 source 锁防御未来 skill metadata 扩 capabilities 时不误命中”，这个说法不成立，未来如果 skill metadata 增加 capabilities，plugin-sourced skill 会被当作 plugin candidate。
  - 修复方向: 当前阶段可以先把注释改成“当前 skill 无 capabilities，因此不会命中”；若以后 skill capabilities 进入 metadata，再用 surface/type helper 区分 plugin extension。
  - 置信度: high

## 5 维度核对结果

| 维度 | 结论 | 关键发现 |
|---|---|---|
| 正确性 | PASS | plugin candidate 的内容等价：旧路径读 `plugin.manifest.capabilities/state/version/description`，新路径经 `loadedPluginToExtension` 投影后仍保留这些字段。差异是候选顺序从 PluginRegistry 插入顺序变成 ExtensionRegistry 排序，列为 L1。 |
| 完备性 | PASS | `runtimeState?` 缺失时在 CapabilityRecommender 中会被当作非 active candidate，不会崩；生产 ExtensionRegistry 对 plugin/skill 都会填 runtimeState。混合 plugin+skill、同 id 不合并的既有约定还在。 |
| 一致性 | PASS | `ExtensionRuntimeState` 和 `PluginState` 当前字面量一致，`_runtimeStateCompat` 能在 PluginState 新增成员时触发编译失败；`loadedPluginToExtension` / `parsedSkillToExtension` 与既有 `*ToMetadata` 命名可读。source filter 只出现一处，暂不需要抽 helper。 |
| 性能/资源 | PASS | `scanForCapability` 会触发 `getExtensions()` 全量投影和排序，但调用点是 recommend_capability/tool error/tool search 这类诊断路径，不是输入热路径；100+ plugin 量级下对象重建和排序成本可接受。 |
| 测试有效性 | PASS | 定向 vitest 3 文件 48 case 全过，typecheck 通过。adapter 测了 active/inactive/activating/error/disabled；registry 测了 plugin runtimeState 和 skill active。剩余薄点是候选排序和 source filter 对“带 capabilities 的 skill-like extension”没有显式测试，对应 L1/L2。 |

## Phase 3a 特定核对(逐条 Y/N + 证据)

A. AgentExtension.runtimeState 字段语义: Y — 当前通过。`loadedPluginToExtension` 直接映射 `plugin.state`，`parsedSkillToExtension` 固定 skill 为 `'active'`；当前唯一新增消费方 CapabilityRecommender 还同时要求 source 为 builtin/plugin 且 capabilities 命中，实际 skill metadata 没有 capabilities，不会只因 `runtimeState === 'active'` 被当作 plugin。

B. source filter 锁定: Y — 当前通过。builtin plugin loader 在 `loadBuiltinPlugins()` 里唯一生成 `rootPath: builtin:${manifest.id}`；磁盘插件来自 `loadPlugin(pluginDir)`，rootPath 是插件目录路径，正常不会以 `builtin:` 开头。第三方插件若通过非正常注入伪造 `rootPath`，会被误分为 builtin，但这不是当前 loader 路径。

C. description fallback: Y — 当前通过。旧路径 `plugin.manifest.description` 对缺失值返回 undefined；新路径先在 metadata 层把缺失转成 `''`，再在 candidate 层用 `|| undefined` 转回 undefined。显式空字符串会从 `''` 变成 undefined，但当前下游只渲染 candidate.name，grep 未发现 `candidate.description` 消费点。

D. version fallback: Y — 当前通过。`PluginManifest.version` 在类型、loader normalize、validator 里都是必需字段；新路径的 `?? ''` 只是适配 DTO 的 string contract。当前 UI/render 路径没有消费 `candidate.version`，所以即使兜底成空字符串，也不会显示成裸 `v`。

E. mock 体系切换: Y — 当前通过但有测试边界。CapabilityRecommender 单测手写 `pluginToExtension` helper，没有 import 真 adapter；这让 Recommender 测试保持服务级隔离，同时 adapter/registry 已有独立测试覆盖。代价是它不能作为迁移层集成测试，候选排序和 skill-like extension 过滤边界没有被这组测试锁住。

## 验证记录

- `git log --oneline 3479ec8b..HEAD`: 仅包含 `475d6742` 和 `2e75f435`
- `git diff 3479ec8b..HEAD -- src/main/extension/`
- `git diff 3479ec8b..HEAD -- src/main/services/capability/`
- `git diff 3479ec8b..HEAD -- tests/unit/`
- `rg -n "loadBuiltinPlugins|rootPath.*builtin:" src/main/plugins/`
- `rg -n "candidate\\.description|candidate\\.version|candidate\\.name|plugin\\.candidates|candidates\\.map" src/renderer src/main src/shared tests`
- `rg -n "ExtensionRuntimeState|PluginState" src/`
- `npx vitest run tests/unit/extension/adapters.test.ts tests/unit/extension/extensionRegistry.test.ts tests/unit/services/capability/CapabilityRecommender.test.ts` -> 3 files / 48 tests passed
- `npm run typecheck` -> passed
- `git diff --check 3479ec8b..HEAD` -> passed
