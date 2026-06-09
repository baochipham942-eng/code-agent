# 2026-06-08 经验沉淀重做、Telemetry 可诊断性与稳定性收尾 Spec（as-built）

> 状态: accepted
> 时间窗: 2026-06-07 下午 ~ 2026-06-08（承接已记入 v9.19 的 06-06~07 上半批）
> 依据: `main` 上 `20df78c9b`..`fae016e23` 区间提交 + 06-07 下午稳定性修复
> 关联决策: [ADR-020 经验沉淀重做](../decisions/020-experience-distillation-redesign.md)
> 关联设计: [经验沉淀重做 + 卸载/权限三层修复](../designs/experience-distillation-and-uninstall-fixes.md)、[Telemetry 可诊断性增强方案](../designs/telemetry-diagnosability-plan.md)
> 关联架构: [agent-core.md](../architecture/agent-core.md)、[data-storage.md](../architecture/data-storage.md)

## 背景

一次 dogfood 会话同时暴露了多条问题，串成了这一批的主线：

1. **经验沉淀产垃圾草稿** —— 连跑 3 次 `bash` 就被提议存成 `bash-bash-bash-bash` skill。
2. **卸载死锁** —— 全权限模式下"卸载 app"反复说"正在等你确认"却从不发起删除工具调用。
3. **出问题查不出** —— 可观测性能回答"做了什么/花了多少 token"，但无法脱离用户机器复现一条完整轨迹，每次迭代像打补丁。

围绕这三条收了三件事：经验沉淀机制重做（ADR-020）、Telemetry 可诊断性增强（版本指纹 + Langfuse 默认开）、卸载/权限三层修复。外加 06-07 下午一组 provider/session/vision 稳定性收尾。

## 非目标

- **不改全权限默认值**：`bypassPermissions.dangerous` 维持 `'prompt'`。危险操作保留一次确认（用户拍板），本批只让"一次确认"真正能走通。
- **Telemetry 默认链路推广前未收敛为 metadata-only**：dogfood 期接受内容入 Langfuse generation，**推广前必须改回 metadata-only 或服务端代理签发短期 token**（列为发布 gate，见设计文档决策记录 §2/§3）。
- **P2 上报形态推广前未改回知情同意**：现阶段为 dogfood 期**静默自动上传**（先跑脱敏再传），**推广前必须改回"知情同意 + 内联轻提示"**（发布 gate）。
- **不保留 telemetry n-gram 召回**：物理移除，不做"加语义过滤保留双路"的折中。

## 变更映射

### 1. 经验沉淀重做（ADR-020 核心）

经验沉淀（skill 自动提议）原有两条并联链路：telemetry n-gram 频次蒸馏（产垃圾）+ LLM 语义复盘（好种子）。本批废弃前者，统一收口到后者并升级到 Hermes/Anthropic 规格。

| 主题 | 关键 commit | 关键文件 |
|------|-------------|----------|
| n-gram 路止血（feature flag 默认关） | `20df78c9b` | `agent/runtime/learningPipeline.ts`、`shared/constants/memory.ts` |
| conversationReview 升级到 Hermes 规格 + 命名禁用清单 | `635d282db` | `lightMemory/conversationReview.ts`、`services/skills/skillDraftQueue.ts`、`shared/constants/memory.ts` |
| 物理移除 telemetry n-gram 成功蒸馏路 | `ef7cd1471` | `agent/runtime/learningPipeline.ts`（-147 行）、`shared/constants/memory.ts`、对应单测 |
| 升格 ADR-020（accepted） | `fae016e23` | `docs/decisions/020-experience-distillation-redesign.md` |

核心合同：

- **入口闸（任务级，非动作级）**：任务完成 + 非平凡（序列含 **≥2 种语义不同工具**，或多步间有数据流依赖）。纯单工具重复（全 bash / 全 read）直接不进。
- **反思门替代频次判据**：LLM 读 trajectory 抽不出"可陈述的任务意图"→ **沉默，不提议**。取代旧的"同序列 ≥3 次就提议"。
- **命名**：动名词 + 领域宾语（`deploying-tauri-macos`）；禁用泛词（`helper/utils/tools/documents/data/files/run-bash`）与工具名拼接（`bash-bash`）。落到 `isLowValueSkillName`，在**解析**与**入队**两处拦截。
- **产物**：SKILL.md 结构化（When to use / Quick reference / Procedure / Pitfalls / Verification），复用 [ADR-002](../decisions/002-agent-skills-standard.md) 的解析与渐进加载。
- **去重**：沿用 `skillDraftQueue` 的 rejected/accepted/pending 三账本（按 patternKey）。
- **failure journal 链路不受影响**：重复失败模式 → Light Memory 保留。

边界澄清：skill 召回从此依赖 quick model 复盘质量，模型不可用时本轮静默降级不沉淀（可接受）。这是 LLM-facing 改动，需配 eval 观察沉淀质量与误报率。

### 2. 卸载/权限三层修复

三层根因各打一处，让"一次确认"真正能走通：

| 层 | 根因 | 修复 | 关键 commit / 文件 |
|----|------|------|-------------------|
| 模型层光说不做 | 宪法"删除前请求确认"被模型理解成**口头**确认，生成"正在等你确认"文本而不发起工具调用 | safety.ts 改措辞：删除/卸载这类操作**直接调用工具**，确认交给权限卡片，禁止光说不做 | `b537de71b` · `prompts/constitution/safety.ts` |
| 命令分级硬毙误杀 | 正则把**任何删绝对路径的 rm 一律判 `critical`** → 删 `/Applications/Xxx.app` 永远到不了确认环节 | rm 删除分级：目标明确的单路径删除从 `critical 硬毙` 降为 `high → prompt 一次确认`；真正灾难性（`rm -rf /`、`~`、`/*`、通配删根/家）仍硬毙 | `306822e32` · `security/commandSafety.ts` + 单测正/负例 |
| 确认请求死锁 | 权限请求挂 `pendingPermissions` 等 Promise，用户下一条消息开新 turn 无逻辑 resolve 旧挂起 → 干等 60s 超时 deny | 新消息/取消时 resolve 挂起 permission，不再冻结到超时 | `d0e0262b2` · `agent/agentOrchestrator.ts` |

### 3. Telemetry 可诊断性增强（P1 + P2 + P3 全部落地）

把迭代从"打补丁"升级为"按版本归因 + 现场可复现"。P1（版本指纹）、P2（本地全量 + 触发上报）、P3（Langfuse 默认开）三阶段全部落地。

> ⚠️ 分支说明：版本指纹（P1）与 Langfuse 默认开（P3）在 `fix/experience-distillation-and-uninstall`（`7ef56edc6`/`af4c9e3f7`）和 `feat/telemetry-diagnosability`（`c3220f27f`/`f7596546c`）上各独立提交过一次。合并时**以 telemetry 分支为准**（更新更全的实现），整条线随 merge commit `cd0ffb9d3` 进 main。下表 commit 取 telemetry 分支的 canonical 版本。

| 阶段 | 关键 commit | 关键文件 |
|------|-------------|----------|
| P1 trace/session 版本指纹 | `c3220f27f` | `telemetry/diagnosticVersions.ts`（新增）、`shared/constants/agent.ts`（`PROMPT_VERSION`）、`shared/contract/telemetry.ts`、`services/core/database/{schema,migrations}.ts`、`telemetry/{telemetryCollector,telemetryStorage}.ts`、`services/infra/langfuseService.ts`、`agent/runtime/conversationRuntime.ts` |
| P2 本地全量诊断 raw 旁表 + 滚动淘汰 | `d46b8f0c5` | `telemetry/telemetryStorage.ts`（`telemetry_raw_payloads` 旁表 + 滚动淘汰）、`services/core/database/{schema,migrations}.ts` |
| P2 诊断包组装 `buildDiagnosticBundle` | `52ea8a742` | `telemetry/diagnosticBundleService.ts`（新增） |
| P2 上传前脱敏 `sanitizeDiagnosticBundle` | `a6db1e8fb` | `telemetry/diagnosticBundleService.ts` |
| P2 失败 session 静默诊断包上报（P2 完成） | `f7cb19b0c` | `telemetry/telemetryCollector.ts`、`telemetry/telemetryUploaderService.ts`、`telemetry_diagnostic_bundles` 排队表 |
| P2 诊断包上传整链路自检脚本 | `d3a3da253` | `scripts/`（自检） |
| LogMasker 超大输入预截断（修 ~110s 卡顿） | `1f5755ae8` | `security/logMasker.ts` |
| P3 Langfuse 默认开 + opt-out（含 P3 覆盖范围结论更正） | `f7596546c`、`73fc7f50c` | `app/initBackgroundServices.ts`、`renderer/.../settings/tabs/PrivacySettings.tsx` |

核心合同：

- **三个版本字段**进 Langfuse trace metadata + 本地 SQLite session 表：
  - `agentVersion` = `getAppVersion()`（package.json version，自动）。
  - `promptVersion` = `shared/constants/agent.ts` 的 `PROMPT_VERSION` 常量（人读粗标签，**改任何 prompt 静态模块后手动 bump** `sys-vN`）。
  - `toolSchemaVersion` = 运行时对 protocol registry 排序后 schema 算 SHA-256 前 12 位（自动确定性，进程内 memoize）。
- **设计变更**：放弃原计划的 build 期 `gen-prompt-registry.ts` 扫静态文件——运行时 system prompt 是逐块**动态拼装**，hash 每次不同，静态扫描匹配不上运行时 hash。精确复现仍靠 turn 级 `systemPromptHash` + `system_prompt_cache`（全文本地存）。
- **Supabase 上传 payload 暂不动**：加云端表没有的列会让 insert 报 `column does not exist` 把上传搞挂。待后台给 `telemetry_sessions` 加 `agent_version/prompt_version/tool_schema_version` 列后再补。
- **P3 复用既有 env fallback**：`configService.getServiceApiKey('langfuse_public'/'langfuse_secret')` 已内置 `LANGFUSE_*_KEY` env fallback，P3 无需新写 key 注入，只补两件：① `initBackgroundServices` 原逻辑只看 key 在不在、完全没读 `settings.langfuse.enabled`，改为 `enabled===false` 显式跳过、否则只要 key 可用就 init；② 隐私设置页加 telemetry 开关（默认开，浅合并避免抹掉 key，改后重启生效）。
- **key 提供 = 运维步骤**：项目默认 `LANGFUSE_*_KEY` 放进打包的 `~/.code-agent/.env`，即对所有用户默认开。**secretKey 严禁硬编码进 TS 源码**。
- **P2 录制默认且无感（本地全量），上报是"同意上报已录好的现场"而非"开启录制"**：本地 `telemetry_raw_payloads` 旁表存全量（prompt/completion/工具入出参全文），三重封顶滚动淘汰（最近 N turn / 天数 / 库体积，单条超阈截断 + 记原长）；命中失败信号（`errorCategory`/`circuitBreaker`/`outcome=failure`/👎）打包诊断包，`sanitizeDiagnosticBundle` 跑密钥/token/PII 脱敏后入 `telemetry_diagnostic_bundles` 排队上传。**本地原文不动，只脱敏上传副本**。dogfood 期为静默自动上传（见风险与发布 gate）。

### 4. 06-07 下午稳定性收尾

承接 06-06~07 上半批（已记入 v9.19）的一组 provider/session/vision 健壮性修复：

| 主题 | 关键 commit | 关键文件 |
|------|-------------|----------|
| harden provider selection + diagnostics | `13d27f9b3` | `model/adapters/aiSdkAdapter.ts`、`model/providerConnectionTest.ts`、`agent/runtime/{toolArgsValidator,toolExecutionEngine}.ts`、`telemetry/telemetryCollector.ts`、`evaluation/telemetryQueryService.ts` |
| 云端同步会话改幂等 upsert，修 NULL-owner 主键冲突刷屏 | `7e8fe97cc` | session 同步路径 |
| sseStream 响应头首字节超时，修 accept-then-hang 干等 | `a77c43256` | provider sseStream |
| 截图发非视觉模型时不再丢图，改用配置的识图模型 | `736bcfc19` | vision 路由 |
| skill 名称容错兜底解析 + did-you-mean 建议 | `fa2679768` | skill 名称解析 |
| 删除 mailboxBridge + 10 个未用依赖 | `0cc8b5b58` | 依赖瘦身 |
| 抽取 `trackFileMutationSideEffects` / `handleToolExecutionError` 收敛 executeSingleTool | `7f7a26bfb`、`ecbdc2af0`、`8441d1063` | `agent/runtime` 重构（行为不变） |

## 验收和证据

| 范围 | 证据 |
|------|------|
| 经验沉淀 | "连跑 3 次 bash"会话不再产草稿；真实多步任务产出意图命名 + 结构化 SKILL.md；`conversationReview.test.ts`（非平凡判定/意图抽取/禁用泛词）、`learningPipeline.test.ts`（n-gram 路移除后回归） |
| 卸载/权限 | 全权限模式"卸载 X" → 模型直接调 rm → 弹一次确认卡 → 确认后真正删除（targeted path 不再硬毙）；追问能恢复执行不死锁；`commandSafety.test.ts` 覆盖"删根/家/通配仍硬毙"正/负例 |
| Telemetry | 任意 trace 可见 `promptVersion`；全新安装未配 key 云端也能看到 metadata 级 trace；隐私页可一键关闭 |
| 版本 | `v0.16.98`（`d24d39513`），release gate baselines 已刷新（`1d5c71744`），desktop 启动放宽（`d51fa2086`） |

## 当前风险

- **commandSafety 松绑是安全敏感改动**：必须保证"删根/家/通配"仍硬毙，已加单测覆盖；safety.ts 措辞改动可能影响其它破坏性操作的模型行为，需回归观察。
- **Telemetry 默认链路目前会把内容传给 Langfuse**（含 userMessage 与 LLM generation input/output）。dogfood 期可接受（自己的 Langfuse 项目）；**推广前必须收敛为 metadata-only 或服务端代理短期 token，并补首启知情同意流程**——列为发布 gate。
- **skill 召回单点依赖 quick model 复盘质量**：模型不可用时本轮不沉淀（静默降级）；需 eval 持续观察误报率。
- **P2 静默上传是 dogfood 期临时形态**：失败 session 现为静默自动上传（已先脱敏），**推广前必须改回"知情同意 + 内联轻提示"并补首启同意流程**（与上方默认链路 gate 并列为发布 gate）。
- **本地全量录制增加磁盘占用与加密面**：滚动淘汰阈值（turn 数/天数/库体积/单条截断）设为配置项，需按实际占用回调。
