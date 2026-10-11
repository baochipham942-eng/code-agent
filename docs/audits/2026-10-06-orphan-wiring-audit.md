# 孤儿能力接线审计（2026-10-06）

- 单号：N-ORPHAN-WIRING-AUDIT（只读审计：不改 src/，不删不接线，只产出判定表）
- 数据源：`scripts/knip-production-ratchet-baseline.json`（生产不可达文件基线，54 项）与 `scripts/knip-production-export-ratchet-baseline.json`（无生产消费方导出基线，3489 项，含 114 个 unreachableFiles）；生产入口见 `knip.production.json`。
- 工具：`scripts/audit-orphan-candidates.mjs`（本单新增，只读）把两份基线蒸馏成三层候选：T1=文件基线全量；T2=src/renderer 下零 importer 的 .tsx（importer 计数对 src/ 与 tests/ 全量解析，生产/测试分列，co-located 测试按测试口径）；T3=renderer 无生产消费方的 `export` 符号按文件分组，≥3 个符号进判读名单。`src/host/extension/**`（冻结工单 N-EXTREGISTRY-WIRE 覆盖）一律剔除。
- 行号会漂移：本文所有 `路径:行号` 以 2026-10-06 主干为准，复核时以 grep 为准。

## 汇总

| 层 | 判读 | 判定分布 |
|---|---|---|
| T1 文件基线 | 54/54 全判 | wire 4 · delete 20 · replaced-elsewhere(处置同为删) 30 |
| T2 零 importer renderer .tsx | 16/16 全判（全部 ⊂ T1） | 并入 T1 行，另补第二轮责任关键词检索 |
| T3 export 符号 | 57 文件 / 293 符号全判 | delete 56 · replaced-elsewhere 1 |
| T3 deferred | 208 文件 / 250 符号 | 未判读，只记计数（附录 A） |

wire 建议工单 4 张：

1. **ResearchProgress** —— Renderer 消费 `research_progress` 事件（组件已备、host 已在发，只差挂载）
2. **PlanningPanel** —— 把 PlanningPanel 挂进会话 UI 或连同 `showPlanningPanel` 开关一起删（数据 `appStore.taskPlan`、词条、advanced 门控全都在）
3. **ReportStyleSelector** —— ChatInput 接入深度研究报告风格选择（i18n 词条与 host `adaptiveConfig.reportStyle` 就绪，现状只能靠意图自动解析）
4. **dashboard/registry** —— Dashboard 验证器子系统（`runtime/dashboard/**`）接入看板类交付的生成/验收链，镜像 `pptGenerate → DeckVerifier` 的既有用法

## 证据口径（本文所有行共用）

下列命令为各行证据的**原样命令**（`<NAME>` 为该行替换后的实际标识符）；命中数均已排除定义文件自身：

```
# ① 引用搜索（T1/T2 行，stem = 文件名去扩展名；同目录相对导入同样命中）
grep -rn "<stem>" src tests scripts packages admin-console vercel-api --include="*.ts" --include="*.tsx" --include="*.mjs" --include="*.js" | grep -v "^<file>:"
# ② 符号搜索（T3 行，词边界整词匹配）
grep -rnw "<SYMBOL>" --include="*.ts" --include="*.tsx" --include="*.mjs" src tests scripts packages | grep -v "^<file>:"
# ③ 责任关键词（零消费行第二轮，抓动态导入/字符串注册表/懒路由等间接接线）
grep -rn "<keyword>" src tests scripts packages --include="*.ts" --include="*.tsx" --include="*.mjs"   # 计数排除 scripts/knip* 基线自引用
# ④ importer 索引（别名 @renderer/@shared/@host/@ + 相对路径 + 动态 import 的机器解析，与 ① 互相印证）
node scripts/audit-orphan-candidates.mjs --json <out.json>
```

命中分类记法：`ext=N`（①或②的全量外部命中）、`test-only`（命中仅在 tests/ 或 co-located 测试）、`0`（零外部命中）、`同名`（命中是别处的同名局部定义/真源，非本导出的消费者）、`114`（命中文件自身在导出基线 unreachableFiles 名单里）。

## T1 · 生产不可达文件基线（54 行全判）

| 文件 | 消费方证据（① 引用 / ③ 责任关键词） | 判定 | 处置 / 备注 |
|---|---|---|---|
| src/host/agent/agentLoopIterator.ts | ①ext=0；③"AsyncGenerator\|async iterator"=0 | **delete** | Claude-SDK 兼容流式迭代器，零消费；agentLoop 事件流自身够用 |
| src/host/agent/guiAgent.ts | ①ext=54（全部命中是同名 tools/vision/guiAgent.ts 体系）；③"@ui-tars/sdk"=4（tools/vision/guiAgent.ts:344 动态 import 的是 SDK 的 GUIAgent，非本类） | replaced-elsewhere → delete | 自研 GUIAgent 类被 `@ui-tars/sdk` 实现取代（vision/guiAgent.ts:355 `new GUIAgent`） |
| src/host/agent/parallelErrorHandler.ts | ①ext=2（仅 autoAgentCoordinator.test.ts:90 的陈旧 vi.mock 与 cancellation.ts:21 注释）；③"并行错误处理"=0 | **delete** | 被测模块 autoAgentCoordinator 已不再 import 它；mock 是陈旧遗留，删除时一并清 |
| src/host/agent/progressAggregator.ts | ①ext=1（仅同上陈旧 vi.mock，autoAgentCoordinator.test.ts:87）；③"进度聚合"=0 | **delete** | 同上 |
| src/host/agent/runtime/dashboard/registry.ts | ①ext=3086（"registry"为通用词，噪声）；importer 索引 0/0；③"DeckVerifier"=26（镜像的 deck 体系已接 pptGenerate.ts:609） | **wire** | 看板验证子系统（registry+types+general/*，全部在 114 名单）整体未接线；deck 侧同构模式已在生产。工单见汇总④ |
| src/host/agent/sessionPersistence.ts | ①ext=3（命中是无关的 claude-subscription-cli `sessionPersistence:false` 配置项）；③"durable run"=920 | replaced-elsewhere → delete | 会话恢复由 Durable Run/会话管理接管 |
| src/host/agent/teammate/teamPersistence.ts | ①ext=1（schema.ts:837 注释）；③"DurableRun"=851 | replaced-elsewhere → delete | 文件头自述：生产 checkpoint 唯一事实源是 Durable Run SQLite；"历史兼容/迁移工具"从未接线 |
| src/host/agent/types/builtinAgents.ts | ①ext=0；③"dynamicAgentFactory\|builtin agent"=24（agentRegistry.ts:9 "CORE_AGENTS 作为 builtin 真理源"） | replaced-elsewhere → delete | 内置 agent 定义真源是 agentRegistry 的 CORE_AGENTS |
| src/host/cowork/coworkContract.ts | ①ext=0；③"CoworkContract"=12（全在自身与 contract/cowork.ts） | **delete** | Cowork 角色体系 Phase 1 未落地；连带 shared/contract/cowork.ts（见下行） |
| src/host/cron/index.ts | ①ext=6533（"index"通用词噪声；importer 索引 0/0）；③"cron/cronService"=22（cron.ipc.ts:10 等 4 处生产直连） | **delete**（barrel） | 底层 cronService 被直连；barrel 零消费 |
| src/host/errors/errorClassifier.ts | ①ext=21（唯一生产 importer 是同为基线死文件的 parallelErrorHandler.ts）；③"agentErrorClassification"=6（shared 真源） | replaced-elsewhere → delete | 错误分类真源 `@shared/utils/agentErrorClassification`（host/renderer 两端共用） |
| src/host/errors/handler.ts | ①ext=4045（"handler"通用词噪声；importer 索引 0/0）；③"agentErrorClassification\|AgentErrorCard"=31 | replaced-elsewhere → delete | 同上簇；错误呈现走 AgentErrorCard |
| src/host/errors/recoveryEngine.ts | ①ext=3（唯一生产 importer 是死的 error.ipc.ts）；③"ErrorRecovery"=13（活体是 contextAssembly/inference.ts:1189 的 runNetworkErrorRecovery 推理重试） | replaced-elsewhere → delete | ⚠️ 它是 `scripts/knip-production-ratchet.mjs` 的 ANCHOR（:47）与单测锚点：删除时必须同步换锚，否则门自证失效 |
| src/host/errors/recoveryTypes.ts | ①ext=2（唯一 importer 是死的 recoveryEngine.ts） | **delete**（簇） | Electron 时代错误恢复引擎的类型层 |
| src/host/errors/types.ts | ①ext=1753（"types"噪声；importer 索引=仅 errorClassifier.ts+handler.ts 两个死文件） | **delete**（簇） | 同簇 |
| src/host/ipc/error.ipc.ts | ①ext=0；③"error_recovery\|recovery event"=17（命中为自身+无关测试类目） | **delete**（簇） | 恢复事件推送通道，renderer 无对应消费 |
| src/host/model/providers/index.ts | ①ext=6533（"index"噪声；importer 索引 0/0）；③"providers/moonshotProvider"=6（modelRouter.ts:104-114 直连各 provider） | **delete**（barrel） | modelRouter 逐一直连；barrel 零消费 |
| src/host/planning/autoPlanner.ts | ①ext=1（adaptiveRouter.ts:167 注释）；③"researchPlanner"=9 | replaced-elsewhere → delete | 自动规划由 researchPlanner / 规划工具链承担 |
| src/host/scheduler/index.ts | ①ext=6533（"index"噪声；importer 索引 0/0）；③"scheduler/TaskDAG"=13（orchestratorDagSync.ts:10、autoAgentRunner.ts:14 直连） | **delete**（barrel） | TaskDAG/dagEventBridge 被直连；barrel 零消费 |
| src/host/services/learning/errorLearning.ts | ①ext=1（codexSessionParser.ts:24 的 TODO 注释）；③"errorLearning"=2（同注释） | **delete** | 错误→恢复模式学习从未开工，注释是计划不是消费 |
| src/host/tools/dispatch/denyRules.ts | ①ext=8（命中的是 GeneralSettings 的 `denyRules` 输入框字符串，非本模块）；③"isToolDeniedByRunPolicy"=41（runToolPolicy.ts:61，toolExecutor.ts:48 在用） | replaced-elsewhere → delete | 工具拒绝的现行机制是 RunToolPolicy；本模块是平行的旧机制 |
| src/host/tools/document/outlineGenerator.ts | ①ext=0；③"outline"=329（多为 CSS outline；活体大纲生成是 slidesGenerator 的 buildSlidesOutline，proposeSlidesOps.ts:22） | replaced-elsewhere → delete | 文档大纲+检索词推导由 slidesGenerator / researchPlanner 覆盖 |
| src/host/tools/media/mermaidToNative.ts | ①ext=1（ppt/types.ts:112 注释）；③"MermaidDiagram\|mermaidExport"=28 | replaced-elsewhere → delete | mermaid 渲染：renderer MermaidDiagram（活体）+ host mermaidExport 模块（活体） |
| src/host/tools/media/ppt/__tests__/preview-all-layouts.ts | ①ext=0；③"slidesGenerator"=9 | **delete** | 旧 PPT 引擎的手工预览脚本（npx tsx 入口）；引擎已换代。若要保留应挪 scripts/ |
| src/host/tools/media/ppt/mermaid.ts | ①ext=181（"mermaid"通用词；importer 索引 0/0）；③"mermaidExport"=15 | replaced-elsewhere → delete | PPT 内嵌图由 mermaidExport 模块路径接管 |
| src/host/tools/media/ppt/parallelPptEngine.ts | ①ext=0；③"slidesGenerator\|prepareSlides"=10 | replaced-elsewhere → delete | PPT 生成走 services/design/slidesGenerator（workspaceSlidesExport.ts:2） |
| src/host/tools/media/ppt/spacing.ts | ①ext=81（"spacing"噪声；importer 索引=仅 co-located ppt-d3d4.test.mjs，测试口径） | **delete** | 唯一消费者是同目录测试；删除时连测试一起 |
| src/host/tools/modules/_helpers/invokeNativeFromLegacy.ts | ①ext=2（唯一 importer 是死的 WebFetchUnifiedTool.ts:9） | **delete**（簇） | 随 WebFetchUnifiedTool 一起 |
| src/host/tools/web/WebFetchUnifiedTool.ts | ①ext=0；③"webFetch"=85（活体是 tools/web/webFetch.ts + search/） | replaced-elsewhere → delete | 统一抓取工具被 webFetch/webSearch 拆分实现取代 |
| src/shared/contract/contextObservability.ts | ①ext=0；③"contextView"=70（context.ipc.ts:40 起全用 contextView 契约） | replaced-elsewhere → delete | 契约已被 shared/contract/contextView.ts 取代且零引用 |
| src/shared/contract/cowork.ts | ①ext=53（"cowork"命中全是 modeStore 的模式名与文案，非本契约；唯一真实 importer 是死的 coworkContract.ts） | **delete**（簇） | 与 coworkContract.ts 连带 |
| src/shared/contract/managed.ts | ①ext=1154（"managed"噪声；importer 索引 0/0）；③"policy"=1722（企业管控现行载体是仓根 code-agent-policy.toml） | **delete** | 文件头自述"architectural placeholder, implementation deferred"；策略面走 policy TOML |
| src/renderer/components/PlanningPanel.tsx | ①ext=10（组件本体零 importer；命中是 appStore.ts:292,562,772 的 `showPlanningPanel` 开关、secondaryPages.ts:41、useDisclosure.tsx:121 门控、i18n 词条）；③"showPlanningPanel"=5 | **wire** | 数据（appStore.taskPlan）、开关、advanced 门控、词条全都在，只差挂载。工单见汇总②；若决定不接，则组件+开关+词条一起删（并同步 primitivesConvergence.test.ts:41 清单） |
| src/renderer/components/TaskPanel/Context.tsx | ①ext=11384（"Context"通用词噪声；importer 索引 0/0）；③"ContextHealthPanel\|ContextUsagePill"=65（ContextUsagePill/ContextHealthDetailPopover 活体） | **delete** | 旧上下文清单 tab；替代品见交叉发现（面板层 ContextPanel/ContextHealthPanel 自身也未接线） |
| src/renderer/components/TaskPanel/ContextInterventionPanel.tsx | ①ext=3（唯一生产 importer 是死的 Orchestration.tsx:34；余为 i18n ratchet 清单）；③"contextIntervention"=32（命中是自身 i18n 词条与活体 host context.ipc.ts:247 的干预状态） | **delete**（簇） | 随 Orchestration 簇删；host 侧干预能力活体在 context.ipc.ts，UI 由 contextView 面板体系承接 |
| src/renderer/components/TaskPanel/ContextProvenancePanel.tsx | ①ext=3（同上，唯一 importer Orchestration.tsx:35） | **delete**（簇） | 同上 |
| src/renderer/components/TaskPanel/Orchestration.tsx | ①ext=60（"Orchestration"命中是 tab 词条与 evalCenter 无关代码；importer 索引 0/0）；③"TaskWorkspaceOverview"=41（TaskPanel/index.tsx:9,15 现结构） | replaced-elsewhere → delete | TaskPanel 已收敛为 TaskWorkspaceOverview + orchestration/ 子目录；i18n 的 tabOrchestration 词条随之清理 |
| src/renderer/components/TaskPanel/SwarmDependencyMap.tsx | ①ext=4（唯一生产 importer 是 Orchestration.tsx:33 的 lazy）；③"dagStore\|DAGViewer"=15（活体 DAGViewer 在 features/workflow/） | **delete**（簇） | 随簇删；DAG 可视化活体是 workflow/DAGViewer |
| src/renderer/components/design/designSlidesStore.ts | ①ext=0；③"slidesOutlineOps"=4（配套纯操作 slidesOutlineOps.ts 自身也在 114 名单） | **delete** | 渲染端 slides 编辑器整块未接线；生成侧由 host slidesGenerator 接管 |
| src/renderer/components/features/admin/AdminUserScopeSelect.tsx | ①ext=1（evalCenter EvalTelemetryTab.tsx:9 注释："v2 取舍：不带回旧面板的 AdminUserScopeSelect"）；③"admin-console"=16（accessControl.ts:11 "已随管理组迁 admin-console（2026-07 方案 9C）"） | replaced-elsewhere → delete | 管理面归 admin-console；IPC 域 ADMIN 与 host adminService 仍是活体 |
| src/renderer/components/features/chat/ChatInput/EffortSelector.tsx | ①ext=2（仅 chatI18nRatchet.test.ts:40 的 i18n 覆盖清单）；③"setEffortLevel"=27（ModelSwitcher.tsx:220,666 与 modelSwitcherHelpers.tsx:1069-1110 活体） | replaced-elsewhere → delete | effort 选择已并入状态栏 ModelSwitcher；删除需同步 chatI18nRatchet 清单 |
| src/renderer/components/features/chat/ChatInput/ModeSwitch.tsx | ①ext=1（同上 ratchet 清单）；③"AppMode"=4（modeStore.ts:18 只剩 'cowork' 一种模式，:77 注释 "no-op, only cowork mode now"） | replaced-elsewhere → delete | 模式切换已收敛为 cowork-only |
| src/renderer/components/features/chat/ChatInput/ReportStyleSelector.tsx | ①ext=1（同上 ratchet 清单）；③"reportStyle"=46（host 活体：adaptiveConfig.ts:153,180 按意图解析、researchPlanner.ts:369 消费；renderer 侧仅本组件与 i18n chatInput.ts:134 词条） | **wire** | host 端风格参数活体但无 UI 入口，现状只能靠意图自动推导。工单见汇总③ |
| src/renderer/components/features/chat/ContextIndicator.tsx | ①ext=0；③"ContextUsagePill"=31（ChatInput 工具栏活体） | replaced-elsewhere → delete | 上下文指示已由 ContextUsagePill 承担 |
| src/renderer/components/features/chat/ContextUsageIndicator.tsx | ①ext=0；③"ContextHealthPanel"=35（ContextUsagePill + ContextHealthDetailPopover 活体） | replaced-elsewhere → delete | 同上；注意 ContextPanel/ContextHealthPanel 面板层自身未接线（交叉发现） |
| src/renderer/components/features/chat/InlinePlanCard.tsx | ①ext=0；③"PlanApprovalCard"=11（DecisionSlot.tsx:339、ToolStepGroup.tsx:33 活体） | replaced-elsewhere → delete | 计划展示由 PlanApprovalCard（审批卡）+ Turn 时间线承担 |
| src/renderer/components/features/chat/ResearchProgress.tsx | ①ext=12（命中是 host 研究进度数据结构，组件本体零 importer）；③"research_progress"=5（host 在发：deepResearchMode.ts:282、semanticResearchOrchestrator.ts:408；schema 在 agentEventSchemas.ts:487） | **wire** | host 侧事件活体、renderer 零消费——典型"建好没接电"。工单见汇总① |
| src/renderer/components/features/chat/ThoughtDisplay.tsx | ①ext=0；③"ThinkingDigestBanner"=13（TurnCard.tsx:440 活体） | replaced-elsewhere → delete | 思考展示由 ThinkingDigestBanner 承担 |
| src/renderer/components/features/settings/tabs/ControlPlaneSettings.tsx | ①ext=1（仅 settingsContentI18nRatchet.test.ts:54 清单）；③"BUILT_IN_SETTINGS_TAB_IDS"=3（settingsTabs.ts:13 注册表无此 tab；accessControl.ts:11 管理组已迁 admin-console） | replaced-elsewhere → delete | 方案 9C：管理组迁 admin-console；删除需同步 ratchet 清单与 inviteCode 词条（zhSettingsSystem.ts:707） |
| src/renderer/components/features/settings/tabs/InviteCodesSettings.tsx | ①ext=1（同上清单）；③"inviteCode"=43（活体：authStore.ts:238-241 注册流程；管理面归 admin-console） | replaced-elsewhere → delete | 同上 |
| src/renderer/components/features/settings/tabs/UserDashboardSettings.tsx | ①ext=1（同上清单）；③"AdminUserDashboard"=34（类型与 host adminService.ts:22 活体；UI 归 admin-console） | replaced-elsewhere → delete | 同上 |
| src/renderer/components/features/swarm/SwarmMonitor.tsx | ①ext=1（swarm.ts:331 注释）；③"SessionAgentsPanel\|SwarmInlineMonitor"=48（WorkbenchViewContent.tsx:60 挂 SessionAgentsPanel 活体，其内嵌 DiscussionStream.tsx:29,296） | replaced-elsewhere → delete | swarm 可视化由「本会话的代理」面板承担 |
| src/renderer/hooks/useComputerUsePip.ts | ①ext=1（useAgentHalo.ts:38 注释）；③"useSurfaceExecutionPip"=14（App.tsx:151 挂载活体，ADR-046 统一执行面） | replaced-elsewhere → delete | computer-use 专用 PiP 已被 surface-execution 统一 PiP 取代；文件里对 useSurfaceExecutionPip 的 re-export 一并删 |
| src/renderer/services/NetworkMonitor.ts | ①ext=0；③"NetworkStatus"=19（statusStore.ts:16,43,59 活体） | replaced-elsewhere → delete | 网络状态由 statusStore 承担 |

## T2 · 零 importer 的 renderer .tsx（16 行全判，全部是 T1 子集）

方法：`scripts/audit-orphan-candidates.mjs` 对 486 个 `src/renderer/**/*.tsx` 全量做 importer 计数（别名/相对/动态 import 解析；`src/**/__tests__/**` 与 `*.test.*` 按测试口径），排除发行入口后零 importer 的 16 个。每行都做了双检索：①符号名（T1 行的 stem grep）+ ③责任关键词（下表 kw 列）；两轮互证后无一发现间接接线（动态导入/字符串注册表/懒路由）。i18n ratchet 测试里的文件名是字符串清单引用，不是 import。

| 文件 | kw=关键词 → 命中结论 | 判定（同 T1 行） |
|---|---|---|
| src/renderer/components/PlanningPanel.tsx | kw=showPlanningPanel → 开关/门控/词条在，挂载缺 | **wire** |
| src/renderer/components/TaskPanel/Context.tsx | kw=ContextUsagePill → 活体替代 | delete |
| src/renderer/components/TaskPanel/Orchestration.tsx | kw=TaskWorkspaceOverview → TaskPanel 现结构 | delete |
| src/renderer/components/features/admin/AdminUserScopeSelect.tsx | kw=admin-console → 方案 9C 迁走 | delete |
| src/renderer/components/features/chat/ChatInput/EffortSelector.tsx | kw=setEffortLevel → ModelSwitcher 活体 | delete |
| src/renderer/components/features/chat/ChatInput/ModeSwitch.tsx | kw=AppMode → cowork-only 收敛 | delete |
| src/renderer/components/features/chat/ChatInput/ReportStyleSelector.tsx | kw=reportStyle → host 参数活体、UI 缺 | **wire** |
| src/renderer/components/features/chat/ContextIndicator.tsx | kw=ContextUsagePill → 活体替代 | delete |
| src/renderer/components/features/chat/ContextUsageIndicator.tsx | kw=ContextHealthPanel → pill+popover 活体 | delete |
| src/renderer/components/features/chat/InlinePlanCard.tsx | kw=PlanApprovalCard → 活体替代 | delete |
| src/renderer/components/features/chat/ResearchProgress.tsx | kw=research_progress → host 在发、UI 缺 | **wire** |
| src/renderer/components/features/chat/ThoughtDisplay.tsx | kw=ThinkingDigestBanner → 活体替代 | delete |
| src/renderer/components/features/settings/tabs/ControlPlaneSettings.tsx | kw=BUILT_IN_SETTINGS_TAB_IDS → 注册表无此 tab | delete |
| src/renderer/components/features/settings/tabs/InviteCodesSettings.tsx | kw=inviteCode → authStore 注册流活体 | delete |
| src/renderer/components/features/settings/tabs/UserDashboardSettings.tsx | kw=AdminUserDashboard → host adminService 活体、UI 归 admin-console | delete |
| src/renderer/components/features/swarm/SwarmMonitor.tsx | kw=SessionAgentsPanel → WorkbenchViewContent 挂载活体 | delete |

## T3 · renderer 无生产消费方的 export 符号（57 文件 / 293 符号全判）

判定词汇（符号级）：
- **delete**：导出无生产消费方——细分为 `收回export`（实现保留，去掉 export 关键字或按仓内 `*Model.ts` 纯模型模式收敛）、`死符号`（实现连同导出一起删）、`re-export面`（被直连绕过的转发导出，删转发行）。
- **replaced-elsewhere**：消费方用了别处的同名真源/局部副本。

每行证据：②符号 grep 的桶分布（`test-only n / 零 n / 同名 n / re-export n`），关键命中在括号内给 `文件:行`。

| 文件（符号数） | ② 证据桶 | 判定 |
|---|---|---|
| components/ForceUpdateModal.tsx（3） | test-only 2（forceUpdateModal.downloadError.test.ts）+ default 无人以 default 形式消费（App.tsx:21 是具名导入） | delete（收回 export） |
| components/PreviewPanel.tsx（6） | re-export 3（:51 转发 previewPanelModel.ts:56,65,124，消费方直连 model）+ test-only 3（presentationPagePicker/pptxVisualPreview/previewPanel.*.test） | delete（re-export 面 + 收回 export） |
| components/StatusBar/CostDisplay.tsx（3） | test-only 3（budgetCostColor/costDisplayCacheAware.test） | delete（收回 export） |
| components/StatusBar/ModelSwitcher.tsx（7） | re-export 1（buildModelSwitcherEngineSelection 真源在 modelSwitcherHelpers.tsx:920，AgentEngineListSection.ts:35 直连）+ test-only 5 + 注释命中 1（MODEL_OVERRIDE_CHANGE_EVENT 仅 AgentErrorCard.tsx:153 注释） | delete（re-export 面 + 收回 export） |
| components/StatusBar/modelSwitcherHelpers.tsx（19） | 零 10（ENGINE_ICON/ENGINE_*_LABEL/EngineReliabilityPanel/HEALTH_DOT_COLOR/buildEngineModelCompatContext/formatEngineCwdPolicy/formatEngineTooltip/getEngineModelCompatReasonText）+ test-only 8 + 同名 1（isExternalEngineKind：host agentEngine.ipc.ts:38 有自己的同名实现） | delete（死符号 + 收回 export + 同名重复不并） |
| components/TaskPanel/RunWorkbenchCards.tsx（6） | test-only 3 + 零 3（RunTimeline/ToolDiscoverySummary/runStatusClass） | delete（收回 export / 死符号） |
| components/composites/FormField.tsx（3） | 同名 2（Select/Textarea：消费方直连 primitives/Select、primitives/Textarea，internalSdk.ts:9-10）+ default 0 | delete（re-export 面） |
| components/design/DesignLayerPanel.tsx（3） | test-only 3（DesignLayerPanel.test.tsx） | delete（收回 export） |
| components/design/autonomyProposalRouting.ts（3） | test-only 3（autonomyProposalRouting.test.ts） | delete（收回 export） |
| components/design/canvasCameraInput.ts（6） | test-only 2 + 零 3（CANVAS_SCALE_STEP/dragEndCamera/normalizeDelta）+ 同名 1（zoomAt：MermaidDiagram.tsx:120 有自己的局部实现）+ 注释 1（CANVAS_SCALE_MIN 见 DesignCanvasZoomControls.tsx:5 注释） | delete（收回 export / 死符号） |
| components/design/designCanvasTypes.ts（4） | test-only 2（DEFAULT_CAMERA/deserializeCanvasDoc）+ 零 2（CANVAS_DOC_VERSION/DEFAULT_VIDEO_DURATION_SEC） | delete（收回 export / 死符号） |
| components/design/designDocPersistence.ts（4） | test-only 3 + 零 1（DESIGN_DOC_FILE） | delete（收回 export / 死符号） |
| components/design/designTypes.ts（8） | test-only 8（designTypes.test.ts 全量直测） | delete（收回 export，按 *Model.ts 模式收敛） |
| components/design/variantSpine.ts（9） | test-only 7 + 零 1（SPINE_VERSION）+ 注释 1（appendVariant 见 variantAdapters.ts:42 注释） | delete（收回 export / 死符号） |
| features/chat/ChatInput/InputArea.tsx（3） | test-only 2（chatInput.historyNavigation.test）+ default 0 | delete（收回 export） |
| features/chat/ChatInput/agentMentionRouting.ts（3） | test-only 2 + 零 1（normalizeMentionToken） | delete（收回 export / 死符号） |
| features/chat/ChatInput/composerRichTextModel.ts（3） | test-only 3（chatInput.inlineChips.test） | delete（收回 export） |
| features/chat/ChatInput/debugDraftUrl.ts（4） | test-only 1 + 零 3（DEBUG_DRAFT_PARAM/DEBUG_DRAFT_SUBMIT_PARAM/isLocalDebugDraftHost） | delete（死符号 + 收回 export） |
| features/chat/ChatInput/index.tsx（3） | test-only 2（chatInput.liveVoiceSlot.test；LiveVoiceButton.tsx:33 注释引用判据）+ default 0 | delete（收回 export） |
| features/chat/ChatInput/utils.ts（7） | 同名 7：AUDIO/VIDEO/IMAGE_MIMES 与 *_EXTENSIONS 在 InputArea.tsx:37-62、mentionAttachment.ts:27-28 各有局部副本；IGNORED_DIRS 在 host listDirectory.ts:50；shouldProcessFile 零 | **replaced-elsewhere**（统一 import 本模块或删副本，顺带消重复） |
| features/chat/MessageBubble/MediaAssetControls.tsx（4） | test-only 2 + 零 2（getMediaAssetParentLabels/getMediaAssetSourceLabels） | delete（收回 export / 死符号） |
| features/chat/MessageBubble/MermaidDiagram.tsx（6） | re-export 面 6：messageContentParts.tsx:97-105 的转发块（"原有消费者从这里 re-export"）被绕过，测试直连 MermaidDiagram | delete（删 messageContentParts 的转发块；MermaidDiagram 侧导出仅测试消费，收回） |
| features/chat/MessageBubble/MessageContent.tsx（3） | 同名 1（CodeBlock：MermaidDiagram.tsx:15 直连 messageContentParts）+ 零 1（InlineTextWithCode）+ test-only 1（localHtmlHrefToPath） | delete（收回 export / 死符号） |
| features/chat/MessageBubble/ToolCallDisplay/index.tsx（7） | 同名/直连 4（formatParams→utils.ts:156、getToolDisplayName→utils.ts:319、getToolIcon→utils.ts:48、getStatusColor→各处同名）+ re-export 1（getToolStatus 真源 styles.ts:28）+ 直连 1（summarizeTool：ResultSummary.tsx:8 直连 summarizers/）+ 零 1（ToolCallDisplayCompact） | delete（barrel 被绕过，删转发与死符号） |
| features/chat/MessageBubble/ToolCallDisplay/summarizers/index.ts（7） | re-export 面 7（各 *Summarizer.ts 定义，消费方 ResultSummary.tsx:8 直连 summarizers 目录） | delete（barrel 被绕过） |
| features/chat/MessageBubble/messageContentParts.tsx（7） | re-export 6（:97-105 转发 MermaidDiagram）+ test-only 1（decodeMarkdownImagePath） | delete（re-export 面 + 收回 export） |
| features/chat/MessageBubble/utils.ts（3） | 同名 2（formatTime：NativeDesktopSection.tsx:50 用自己的 nativeDesktopActivityModel；languageConfig：messageContentParts.tsx:43 有局部副本）+ 零 1（parseMarkdownBlocks） | delete（死符号；同名重复不并） |
| features/chat/TurnBasedTraceView.tsx（21） | test-only 21（turnBasedTraceView.test.ts 全量直测滚动/跟随判据） | delete（收回 export，按 *Model.ts 模式收敛——最大单文件测试导出面） |
| features/settings/SettingsModal.tsx（4） | test-only 4（settingsUnsavedGuard/settingsModal.screenMemory.test） | delete（收回 export） |
| features/settings/index.ts（5） | re-export 面 5（AboutSettings/AppearanceSettings/DataSettings/ModelSettings/UpdateSettings：SettingsModal.tsx:91-138 直连 tabs/* 懒加载） | delete（barrel 被绕过） |
| features/settings/sections/NativeConnectorsSection.tsx（10） | test-only 10（nativeConnectorsSection.test 全量直测行构建/生命周期） | delete（收回 export，按 *Model.ts 模式收敛） |
| features/settings/sections/localBridge/index.ts（5） | re-export 面 5（InstallGuide/SecurityLevelConfig/StatusIndicator/VersionInfo/WorkingDirectoryPicker：LocalBridgeSection.tsx:8-12 直连各子文件） | delete（barrel 被绕过） |
| features/settings/tabs/MemoryEntriesManager.tsx（5） | test-only 5（memoryEntriesManager.test） | delete（收回 export） |
| features/settings/tabs/ModelSettings.helpers.tsx（5） | test-only 4 + 零 1（renderModelOptions） | delete（收回 export / 死符号） |
| features/settings/tabs/agentEngineSectionHelpers.ts（4） | test-only 4（agentEngineSection.test） | delete（收回 export） |
| features/surfaceExecution/index.ts（4） | re-export 面 4（SurfaceControls/SurfaceEvidenceCard/SurfaceExecutionConversationPanel/SurfaceSemanticTimeline：消费方直连各组件文件） | delete（barrel 被绕过） |
| components/primitives/index.ts（3） | re-export 面 3（PrimaryButton/SecondaryButton/DangerButton：消费方直连 primitives/Button，如 NativeDesktopSection.tsx:57、ProjectSpacePage.tsx:13） | delete（barrel 中被绕过的 3 项；barrel 其余导出仍活，勿整删） |
| components/workbench/WorkbenchPrimitives.tsx（6） | 中转 6（TaskPanel/WorkbenchPrimitives.tsx:3-8 转发，而 Skills.tsx:13 又直连 TaskPanel 侧；且 TaskPanel/WorkbenchPrimitives.tsx 与 Skills.tsx 自身在 114 名单） | delete（双层 barrel 一并收口；注意消费簇本身未接线，见交叉发现） |
| hooks/agent/effects/useSessionLifecycleEffects.ts（5） | 同名 3（classifyAgentError/getAgentErrorMessage/normalizeAgentErrorPayload 真源 @shared/utils/agentErrorClassification，web/routes/agentTurnTerminalFailure.ts:11 在用）+ test-only 2 | replaced-elsewhere → delete（删转发，改 import shared 真源） |
| hooks/agent/effects/useSurfaceExecutionEffects.ts（3） | test-only 3（useSurfaceExecutionEffects.test） | delete（收回 export） |
| hooks/agent/useAgentIPC.ts（14） | 同名 1（formatDesignCanvasSessionReminder 真源 shared/design/canvasSessionReminder，workbenchTurnContext.ts:29 在用）+ 转发 1（resolveDirectRouting 经 useAgent.ts:45 再导出，无人生产消费）+ test-only 11 + 注释 1（withCanvasSnapshotContext 见 web/routes/agent.ts:974 注释） | delete（删转发/收回 export；shared 真源保留） |
| hooks/useCurrentTurnCapabilityScope.ts（4） | test-only 3 + 零 1（extractCurrentTurnWorkbenchSnapshot） | delete（收回 export / 死符号） |
| hooks/useKeyboardShortcuts.ts（3+default） | 零 4（DEFAULT_SHORTCUTS/formatShortcut/getShortcutsList/default） | delete（死符号；快捷键活体在 KeybindingsSettings） |
| hooks/useRendererBundleAutoReload.ts（3） | 零 3（三个 DEFAULT_* 常量） | delete（死常量导出，收回） |
| hooks/useRunWorkbenchModel.ts（5） | test-only 5（useRunWorkbenchModel.test） | delete（收回 export） |
| hooks/useSurfaceExecutionPip.ts（4） | test-only 4（useSurfaceExecutionPip.test） | delete（收回 export） |
| hooks/useTaskSync.ts（3） | test-only 3（useTaskSync.test） | delete（收回 export） |
| stores/dagStore.ts（2+default） | 零 3（useActiveDAGCount/useDAGVisible/default） | delete（死符号；DAG 展示活体 workflow/DAGViewer 不经此 store） |
| stores/swarmStore.ts（3） | test-only 2（MAX_RUN_SNAPSHOTS×2）+ 零 1（getSwarmRunSnapshotKey） | delete（收回 export / 死符号） |
| utils/deliverables.ts（3） | test-only 2 + 114 1（buildDeliverableCardFromWorkspaceItem 的唯一消费方 WorkspacePreviewPanel.tsx:42 自身在 114 名单） | delete（收回 export；若 WorkspacePreviewPanel 簇决定接线则改判） |
| utils/sessionNeedsInput.ts（3） | test-only 3（sessionNeedsInput.test） | delete（收回 export） |
| utils/sidebarMessageSearch.ts（3） | test-only 3（sidebarMessageSearch.test） | delete（收回 export） |
| utils/streamingPerformanceMetrics.ts（3） | test-only 3（29/20/2 命中全在测试） | delete（收回 export；调试面保留给测试） |
| utils/toolGrouping.ts（4） | test-only 3 + 零 1（groupToolCalls） | delete（收回 export / 死符号） |
| utils/updatePrompt.ts（3） | test-only 3（updatePrompt.test） | delete（收回 export） |
| utils/workbenchCapabilityRegistry.ts（3） | 零 3（buildWorkbenchCapabilityRegistryFromCapabilities/getWorkbenchCapabilityReadiness/isWorkbenchCapabilityAutoAllowed） | delete（死符号；registry 活体消费走别处） |
| utils/workbenchPresentation.ts（4） | 114 2（formatWorkbenchSkillSecondaryText 消费方 Skills.tsx:16、getBrowserWorkbenchReadinessTone 消费方 AbilityMenu.tsx:18——两文件均在 114 名单）+ 零 2（getWorkbenchConnectorStatusPresentation/getWorkbenchSkillCapabilityTitle） | delete（消费簇未接线，见交叉发现；簇接线则改判） |

## 交叉发现（判读过程中发现的更大未接线区域）

1. **context 健康面板家族半接线**：`ContextPanel.tsx` 与 `ContextHealthPanel.tsx`（面板层）在导出基线 unreachableFiles（114 名单）里，而 `ContextUsagePill` + `ContextHealthDetailPopover`（工具栏 pill + 弹层）是生产可达的。即 pill 入口活着、整屏面板入口没通电。T1 的 ContextIndicator/ContextUsageIndicator/TaskPanel/Context.tsx 删除判定不受影响（pill 已覆盖其职责），但「面板层」要另立工单决定接线或删除。
2. **TaskPanel 尾巴**：`TaskPanel/WorkbenchPrimitives.tsx`、`TaskPanel/Skills.tsx`、`TaskPanel/TaskWorkspaceOverview.tsx` 等（含 workbench/WorkbenchPrimitives 的转发消费链）也在 114 名单。T3 表 workbench 两行（WorkbenchPrimitives、workbenchPresentation、deliverables）的消费方均落在该名单——若这簇将来接线，这几行改判 wire。
3. **ChatInput 外挂件成片**：114 名单里 ChatInput 目录还有 modelStrategyRecommendation / ModelStrategyRecommendationStrip / neoMentionRouting / slashCommandDisplayGroups / neoTagSubmit / NeoWorkCardInlineCard / PlanPanel（与 T1 的 PlanningPanel 是两代实现）/ SessionDiffSummary 等，是一个独立的"输入区增强件未接线"簇，建议合并到同一张清理工单。
4. **dashboard 验证子系统**（wire 工单④）：`runtime/dashboard/**` 7 个文件整体在 114 名单，与已接线的 `runtime/deck/**`（pptGenerate.ts:609）同构。
5. **删除 recoveryEngine.ts 须换锚**：它是 `scripts/knip-production-ratchet.mjs:47` 的 ANCHOR 与 `tests/scripts/knipProductionRatchet.test.ts` 的锚点，先改锚再删，否则生产可达性门自证失效（该门注释里 2026-08-14 已踩过一次静默失锚的坑）。
6. **i18n ratchet 清单联动**：删除 T1/T2 中的 renderer 组件时，需同步 `tests/renderer/components/chatI18nRatchet.test.ts`、`settingsContentI18nRatchet.test.ts`、`tests/scripts/primitivesConvergence.test.ts` 里的文件名清单。

## 自检

**⑤ 已知有生产消费者的导出未被列入**：`src/renderer/components/StatusBar/modelSwitcherHelpers.tsx :: buildModelSwitcherEngineSelection`。生产消费方 `AgentEngineListSection.tsx:35`（该文件不在 114 不可达名单，grep 复核命中 2 处 ：35/:163）。核对导出基线：该符号仅以 `ModelSwitcher.tsx` 的**转发导出**形式被记录（无消费者的正是这个转发，T3 表已单列），`modelSwitcherHelpers.tsx` 的原始导出不在基线中 → 候选清单没有误伤活体导出。

**③ 随机抽样 5 行复验**（方法：mulberry32 PRNG、seed=42，对 54 行 T1 表均匀抽样；复验用与初判不同角度的检索——import 说明符形状 + 数据/替代路径）：

| 抽中行 | 复验检索与结果 | 与原判定一致？ |
|---|---|---|
| TaskPanel/ContextProvenancePanel.tsx | 全局仅死文件 Orchestration.tsx:35,601 import 它；活体 orchestration/model.ts:245-246 直接消费 contextView.provenanceEntries 数据而非本面板 | ✓ delete |
| host/tools/media/ppt/mermaid.ts | 零 import 说明符命中；活体 mermaid 链路是 network/mermaidExport（modules/index.ts:651 动态 import） | ✓ replaced→delete |
| settings/tabs/InviteCodesSettings.tsx | 全局仅 settingsContentI18nRatchet.test.ts:53 字符串清单；settingsTabs.ts 注册表无 inviteCodes tab | ✓ delete |
| features/admin/AdminUserScopeSelect.tsx | 全局仅 evalCenter EvalTelemetryTab.tsx:9 的 v2 取舍注释 | ✓ delete |
| host/cron/index.ts | 按说明符形状搜 barrel（`from '../cron'` 等）零命中；全部消费走 contract/cron 与 cron/cronService 直连 | ✓ delete（barrel） |

## 附录 A · T3 deferred（208 文件 / 250 符号，未判读，只记计数）
```
src/renderer/App.tsx:1 src/renderer/api/index.ts:2 src/renderer/api/localToolAbortRegistry.ts:1 src/renderer/components/AgentNoticeToast.tsx:1 src/renderer/components/ChatView.tsx:2 src/renderer/components/CommandPalette.tsx:1 src/renderer/components/DecisionCard.tsx:1 src/renderer/components/DiffView.tsx:1 src/renderer/components/ErrorBoundary.tsx:2 src/renderer/components/LivePreview/DevServerLauncher.tsx:1 src/renderer/components/LivePreview/LocalityFeedbackBar.tsx:1 src/renderer/components/LivePreview/TweakPanel.tsx:1 src/renderer/components/PermissionDialog/utils.ts:1 src/renderer/components/ProviderStatusNotice.tsx:2 src/renderer/components/SessionActionsMenu.tsx:1 src/renderer/components/SessionExpiredNotice.tsx:1 src/renderer/components/Sidebar.tsx:2 src/renderer/components/StatusBar/EngineScopedModelPanel.tsx:1 src/renderer/components/StatusBar/providerLogoCatalog.ts:2 src/renderer/components/TaskPanel/TaskWorkspaceOverview.tsx:1 src/renderer/components/UpdateNotification.tsx:1 src/renderer/components/design/BrandManager.tsx:2 src/renderer/components/design/DesignCostHistory.tsx:1 src/renderer/components/design/annotComposite.ts:1 src/renderer/components/design/canvasDeleteKeybinding.ts:1 src/renderer/components/design/canvasEditHistory.ts:1 src/renderer/components/design/canvasUndoKeybinding.ts:1 src/renderer/components/design/designCanvasMask.ts:1 src/renderer/components/design/designCanvasStore.ts:1 src/renderer/components/design/designDiagramTypes.ts:1 src/renderer/components/design/designDocTypes.ts:2 src/renderer/components/design/designProposedImageGen.ts:1 src/renderer/components/design/designProposedVideoGen.ts:1 src/renderer/components/design/diagramReducer.ts:2 src/renderer/components/design/useDesignCanvasGeneration.ts:1 src/renderer/components/design/useToolbarOverflow.ts:1 src/renderer/components/design/variantAdapters.ts:2 src/renderer/components/features/background/BackgroundSessionPanel.tsx:1 src/renderer/components/features/chat/AgentErrorCard.tsx:2 src/renderer/components/features/chat/ChatInput/AppshotChip.tsx:1 src/renderer/components/features/chat/ChatInput/AttachmentBar.tsx:2 src/renderer/components/features/chat/ChatInput/CapabilitySuggestionStrip.tsx:1 src/renderer/components/features/chat/ChatInput/ComposerUploadStatus.tsx:1 src/renderer/components/features/chat/ChatInput/DictationRecordingBar.tsx:1 src/renderer/components/features/chat/ChatInput/LoopStatusBar.tsx:1 src/renderer/components/features/chat/ChatInput/RoleDraftCard.tsx:1 src/renderer/components/features/chat/ChatInput/SelectedCapabilityChips.tsx:1 src/renderer/components/features/chat/ChatInput/SendButton.tsx:1 src/renderer/components/features/chat/ChatInput/SkillDraftCard.tsx:1 src/renderer/components/features/chat/ChatInput/TeamRecipeDraftCard.tsx:1 src/renderer/components/features/chat/ChatInput/VoiceInputButton.tsx:1 src/renderer/components/features/chat/ChatInput/agentCommand.ts:1 src/renderer/components/features/chat/ChatInput/atMentionPanelModel.ts:1 src/renderer/components/features/chat/ChatInput/chatDiagnostics.ts:1 src/renderer/components/features/chat/ChatInput/parseGoalCommand.ts:1 src/renderer/components/features/chat/ChatInput/slashPickerModel.ts:1 src/renderer/components/features/chat/ChatInput/useChatInputSubmit.ts:1 src/renderer/components/features/chat/ChatInput/useDragAndDrop.ts:1 src/renderer/components/features/chat/ChatInput/useFileUpload.ts:1 src/renderer/components/features/chat/ChatInput/useSkillRecommendations.ts:1 src/renderer/components/features/chat/ContextUsagePill.tsx:1 src/renderer/components/features/chat/GoalStatusBar.tsx:1 src/renderer/components/features/chat/MessageBubble/AttachmentPreview.tsx:1 src/renderer/components/features/chat/MessageBubble/GenerativeUIEditPanel.tsx:1 src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/ToolDetails.tsx:1 src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/bashOutputPreview.ts:2 src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/styles.ts:1 src/renderer/components/features/chat/MessageBubble/ToolCallDisplay/utils.ts:2 src/renderer/components/features/chat/MessageBubble/generativeUIDocument.ts:1 src/renderer/components/features/chat/NewSessionWelcome.tsx:1 src/renderer/components/features/chat/SessionSwitchSkeleton.tsx:2 src/renderer/components/features/chat/StreamingIndicator.tsx:1 src/renderer/components/features/chat/TaskStatusBar.tsx:1 src/renderer/components/features/chat/ToolStepGroup.tsx:1 src/renderer/components/features/chat/TurnCard.tsx:1 src/renderer/components/features/chat/fallbackNotice.ts:1 src/renderer/components/features/chat/goalNotice.ts:1 src/renderer/components/features/chat/neoWorkCardPhase.ts:1 src/renderer/components/features/chat/useProjectChatSeed.ts:1 src/renderer/components/features/cron/CronExecutionDetail.tsx:1 src/renderer/components/features/cron/CronExecutionList.tsx:1 src/renderer/components/features/cron/CronJobDetail.tsx:1 src/renderer/components/features/cron/CronJobEditor.tsx:1 src/renderer/components/features/cron/CronJobList.tsx:1 src/renderer/components/features/cron/CronSimpleCreate.tsx:2 src/renderer/components/features/expert/RoleInitialAvatar.tsx:2 src/renderer/components/features/expert/SessionMemberBar.tsx:1 src/renderer/components/features/knowledge/libraryItemModel.ts:1 src/renderer/components/features/memory/index.ts:1 src/renderer/components/features/projectCollaboration/ProjectCollaborationDetailPane.tsx:1 src/renderer/components/features/projectCollaboration/ProjectCollaborationPage.tsx:1 src/renderer/components/features/projectCollaboration/ProjectCollaborationPanel.tsx:1 src/renderer/components/features/projectCollaboration/index.ts:2 src/renderer/components/features/projectCollaboration/projectCollaborationData.ts:2 src/renderer/components/features/projectSpace/CloudCollabCardsSection.tsx:1 src/renderer/components/features/projectSpace/projectSpaceData.ts:2 src/renderer/components/features/settings/McpServerEditor.tsx:1 src/renderer/components/features/settings/ProviderDoctorDialog.tsx:1 src/renderer/components/features/settings/WebModeBanner.tsx:1 src/renderer/components/features/settings/sections/index.ts:1 src/renderer/components/features/settings/sections/nativeDesktopActivityModel.ts:1 src/renderer/components/features/settings/tabs/KnowledgeInboxSection.tsx:1 src/renderer/components/features/settings/tabs/McpDiscoverTab.tsx:1 src/renderer/components/features/settings/tabs/MemoryDiagnosticsSections.tsx:2 src/renderer/components/features/settings/tabs/OpenchronicleSettings.tsx:1 src/renderer/components/features/settings/tabs/ProviderModelsSection.tsx:1 src/renderer/components/features/settings/tabs/SkillsDiscoverTab.tsx:2 src/renderer/components/features/settings/tabs/SkillsInstalledTab.tsx:2 src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection.tsx:1 src/renderer/components/features/settings/tabs/memoryAuditClient.ts:1 src/renderer/components/features/sidebar/SessionReplaySummaryDialog.tsx:1 src/renderer/components/features/sidebar/SessionTypeFilterBar.tsx:1 src/renderer/components/features/sidebar/SidebarMessageHitList.tsx:1 src/renderer/components/features/sidebar/SidebarProjectDetail.tsx:1 src/renderer/components/features/sidebar/SidebarProjectDrawer.tsx:1 src/renderer/components/features/sidebar/useSidebarDerivedSessions.ts:1 src/renderer/components/features/swarm/DiscussionStream.tsx:2 src/renderer/components/features/swarm/LaunchRequestCard.tsx:1 src/renderer/components/features/voice/VoiceStartDialog.tsx:1 src/renderer/components/features/workflow/DAGViewer.tsx:1 src/renderer/components/features/workflow/DependencyEdge.tsx:1 src/renderer/components/features/workflow/TaskDetailPanel.tsx:1 src/renderer/components/features/workflow/TaskNode.tsx:1 src/renderer/components/features/workflow/useDAGLayout.ts:1 src/renderer/components/onboarding/modelOnboarding.ts:2 src/renderer/components/primitives/Input.tsx:1 src/renderer/components/workbench/AgentPointerOverlay.tsx:1 src/renderer/components/workbench/WorkbenchCapabilitySheetLite.tsx:1 src/renderer/hooks/agent/effects/streamEventNormalizers.ts:2 src/renderer/hooks/agent/effects/useConversationStreamEffects.ts:2 src/renderer/hooks/agent/effects/usePermissionQueueEffects.ts:2 src/renderer/hooks/agent/effects/useTaskProgressEffects.ts:1 src/renderer/hooks/agent/effects/useToolExecutionEffects.ts:1 src/renderer/hooks/useAgent.ts:1 src/renderer/hooks/useBudgetStatus.ts:1 src/renderer/hooks/useCurrentTurnArtifactOwnership.ts:1 src/renderer/hooks/useDisclosure.tsx:1 src/renderer/hooks/useKeybindingsSettings.ts:2 src/renderer/hooks/useMemoryEvents.ts:1 src/renderer/hooks/useMessageBatcher.ts:2 src/renderer/hooks/useOpenPreviewBridge.ts:1 src/renderer/hooks/useStatusRailModel.ts:2 src/renderer/hooks/useSurfaceLiveFrames.ts:1 src/renderer/hooks/useTaskActivity.ts:1 src/renderer/hooks/useTheme.ts:1 src/renderer/hooks/useThrottledStreamingContent.ts:1 src/renderer/hooks/useTurnProjection.ts:1 src/renderer/hooks/useWorkbenchBrowserSession.ts:2 src/renderer/hooks/useWorkbenchCapabilities.ts:1 src/renderer/hooks/useWorkbenchCapabilityQuickActionRunner.ts:2 src/renderer/hooks/useWorkbenchInsights.ts:1 src/renderer/i18n/index.ts:1 src/renderer/i18n/surfaceExecution.ts:1 src/renderer/services/cronClient.ts:1 src/renderer/services/invokeSkillIPC.ts:1 src/renderer/services/loopClient.ts:1 src/renderer/services/nativeDesktop.ts:1 src/renderer/services/projectClient.ts:1 src/renderer/services/rolesClient.ts:1 src/renderer/services/sessionAutomationClient.ts:1 src/renderer/services/surfaceIntentRuntime.ts:1 src/renderer/services/tagClient.ts:1 src/renderer/services/typedInvoke.ts:1 src/renderer/services/voiceAudioPipeline.ts:1 src/renderer/services/voiceEchoHint.ts:1 src/renderer/stores/agentRegistryStore.ts:1 src/renderer/stores/capabilityGapStore.ts:1 src/renderer/stores/composerScopeModel.ts:1 src/renderer/stores/composerStore.ts:1 src/renderer/stores/modeStore.ts:1 src/renderer/stores/neoWorkCardStore.ts:1 src/renderer/stores/secondaryPages.ts:1 src/renderer/stores/sessionCreate.ts:1 src/renderer/stores/streamingMessageAccumulatorStore.ts:1 src/renderer/stores/taskStore.ts:2 src/renderer/stores/workbenchPresetStore.ts:1 src/renderer/utils/browserAnnotation.ts:1 src/renderer/utils/browserNavigationPending.ts:1 src/renderer/utils/displayPath.ts:1 src/renderer/utils/doctorFixActions.ts:1 src/renderer/utils/htmlLocality.ts:2 src/renderer/utils/inAppValidationExecutor.ts:1 src/renderer/utils/logger.ts:2 src/renderer/utils/mcpRecovery.ts:1 src/renderer/utils/osNotification.ts:2 src/renderer/utils/overviewLabels.ts:1 src/renderer/utils/overviewRunHeader.ts:1 src/renderer/utils/previewable.ts:1 src/renderer/utils/projectGoalChatSeed.ts:1 src/renderer/utils/providerIconAssets.ts:1 src/renderer/utils/runWorkbenchProjection.ts:2 src/renderer/utils/sessionAssetsNavigation.ts:1 src/renderer/utils/sessionRecoveryHints.ts:1 src/renderer/utils/settingsIndex.ts:1 src/renderer/utils/sidebarGroupExpansion.ts:2 src/renderer/utils/sidebarSessionOrdering.ts:1 src/renderer/utils/sidebarSessionTiers.ts:2 src/renderer/utils/startEditRoleChat.ts:1 src/renderer/utils/surfaceExecutionProjection.ts:1 src/renderer/utils/toolStepGrouping.ts:1 src/renderer/utils/turnContentVisibility.ts:2 src/renderer/utils/turnDiffExpansionState.ts:1 src/renderer/utils/turnDiffSummary.ts:1 src/renderer/utils/voicePartialOverlay.ts:1 src/renderer/utils/workbenchCapabilitySheet.ts:2 src/renderer/utils/workbenchScopeInspector.ts:1 src/renderer/utils/workspaceGrouping.ts:1 src/renderer/utils/workspacePreview.ts:1
```
