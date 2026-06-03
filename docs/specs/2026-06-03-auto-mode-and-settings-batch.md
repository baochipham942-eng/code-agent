# 2026-06-03 自动模式路由体系 + 设置页重构批次 Spec（as-built）

> 状态: accepted
> 时间窗: 2026-06-02 ~ 2026-06-03
> 依据: [ADR-019 自动模式能力边界](../decisions/019-auto-mode-scope.md)、[竞品调研](../research/2026-06-02-coze-codeg-cumora-competitive-analysis.md)
> 关联架构: [agent-core.md](../architecture/agent-core.md)、[frontend.md](../architecture/frontend.md)、[observability.md](../architecture/observability.md)、[cloud-architecture.md](../architecture/cloud-architecture.md)、[模型配置指南](../guides/model-config.md)

## 目标

这一批次围绕三条主线，把"模型选择"从黑盒变成可解释、可门控、可视化的产品合同，同时完成设置页信息架构重构和桌面稳定性收尾：

1. **自动模式从形同虚设到真正生效**：实测发现 UI 选"自动"后所有路由能力（简单任务→免费模型、带图→视觉模型）在桌面主链路上完全失效，修复三个断点后按 ADR-019 重构为单一决策入口。
2. **设置页信息架构重构**：Skills / 模型 / Agent 引擎 / MCP 四个设置域统一升级为 Master-Detail 或双 Tab 布局，推荐目录接入云端下发。
3. **桌面稳定性与遥测收尾**：僵尸实例自愈、生产 trace 零回传修复、onboarding 死路修复。

## 非目标

- 不做价格感知路由（BYOK 场景价格表不可维护）——以计费语义四分类替代（ADR-019 决策 4）。
- 不做向上路由（自动选更贵模型）——硬约束写进代码层（ADR-019 决策 3）。
- ADR-019 P3（subagent output 精控）排进后续迭代，本批次不含。

## 变更映射

### 1. 自动模式 / 模型路由

| 主题 | 关键 commit | 关键文件 |
|------|------------|----------|
| aiSdk 动态 custom provider baseURL 兜底 | 01aaba43f | model/providers/providerResolution.ts |
| 自动模式 model 层修复（WEB_MODE 守卫 + custom provider 能力识别 + baseUrl 优先级对齐） | 9f403ae82 | model/adaptiveRouter.ts, model/modelRouter.ts |
| 自动模式主链路修复（/api/run adaptive 透传 + aiSdk 引擎接入简单任务路由） | 652259229 | web/routes/agent.ts, agent/runtime/contextAssembly/inference.ts |
| ADR-019 批 1：单一路由决策入口 + adaptive 泄漏修复 | e7730e3a9 (merge 700e427ae) | model/modelDecision.ts |
| ADR-019 批 2：计费语义四分类 + simple 路由门控 + 档位去硬编码 | bd5437db3 (merge 700e427ae) | model/modelDecision.ts, shared/contract/settings.ts |
| ADR-019 批 3：model_decision 透传 + 路由可视化 | 26cc0fad6 (merge 700e427ae) | shared/contract/modelDecision.ts, renderer/.../RouteTraceChip.tsx, FallbackBanner.tsx |
| relay model 处理（unconfigured / mixed） | 282b0e843 | shared/modelRuntime.ts, renderer/.../ModelSwitcher.tsx |
| ModelSwitcher 过滤未配置 API Key 的 provider | 7490ae223 | renderer/.../ModelSwitcher.tsx |

（文件路径省略 `src/main/` / `src/` 前缀。）

### 2. 设置页重构

| 主题 | PR / commit | 关键文件 |
|------|------------|----------|
| Skills 设置页双 Tab（已安装 / 发现安装）+ 全局启停闸控接真 | PR #197 (25da76e9d) | renderer/.../tabs/SkillsSettings.tsx, SkillsDiscoverTab.tsx |
| 模型设置页 Master-Detail 布局 | PR #198 (060320220) | renderer/.../tabs/ModelSettings.tsx |
| Agent 引擎拆为独立设置 tab（stage 2） | cb12b2a06 | renderer/.../tabs/AgentEngineSettings.tsx |
| MCP 设置页双 Tab（发现连接 + 插件管理瘦身） | PR #201 (3a1352165) | renderer/.../tabs/ 下 MCP 相关 |
| 推荐目录云端下发 + 聊天流 skill 导购 | PR #202 (17643131f) | services/catalog/, renderer/.../chat/ |

### 3. Onboarding / 桌面稳定性 / 遥测

| 主题 | PR / commit | 关键文件 |
|------|------------|----------|
| Onboarding 支持中转站/自定义 Provider + 跳过按钮 | 069ff7a23 | renderer/components/onboarding/ |
| Onboarding 死路修复（跳过→直接打开设置页）+ 草稿泄漏 + engine-aware | PR #193 (fe3e86036) | renderer/App.tsx, ChatInput/, sessionStore.ts |
| 僵尸实例/孤儿进程/启动失败三层自愈 | PR #195 (fe95d1e2f) | desktop 启动链路 |
| CLI 子代理 spawn PATH 用 login shell 完整 PATH | 73a2e7969 | services/agentEngine/codexCliAdapter.ts, claudeCodeAdapter.ts |
| GUI smoke 测试与默认 vitest run 隔离 | PR #199 (d0a59aaf4) | vitest.smoke.config.ts |
| Fleet telemetry 上传器在 webServer 路径启动（修复生产 trace 零回传） | 3696cc049 | web/webServer.ts |

## 核心合同

### 自动模式（adaptive）

1. **角色分层为主干，adaptiveRouter 为拦截器**（ADR-019 决策 1）：adaptive 只做能力补齐（vision）和可用性兜底（限流/网络/余额），不覆盖 subagent 角色分层。
2. **simple → 免费模型路由按计费方式门控**：主力模型按量付费才路由（真省钱），包月/订阅默认不路由。
3. **永不向上路由**：自动模式不会选比用户默认模型更贵的模型，这是代码层约束。
4. **所有路由决策走单一入口** `resolveModelDecision()`，输出结构化 `ModelDecision`（requestedModel / resolvedModel / reason / billingMode），UI chip、trace、日志统一消费。
5. **路由对用户可见**：RouteTraceChip 默认收起、点击展开决策详情；降级时 FallbackBanner 原位插入聊天流。

### 设置页信息架构

- 四个设置域（模型 / Agent 引擎 / Skills / MCP）统一为"左列表 + 右详情"或"双 Tab"模式，消除单页长滚动。
- 推荐目录（skills / MCP）数据源：云端下发优先，内置数据兜底。

### 遥测

- Fleet telemetry 上传器生命周期绑定登录态（登录起、登出停），在 webServer 路径（发行版实际路径）启动，E2E 模式跳过。

## 验证

- 全部变更合入 main 后全量 vitest + typecheck 通过（GUI smoke 已隔离到 vitest.smoke.config.ts）。
- 自动模式 E2E（standalone webServer）：简单任务路由到 glm-4-flash 并成功回复；带图请求不再触发误判的 vision fallback。
- 设置页系列各自带 Playwright E2E 截图验证（tests/e2e/）。
