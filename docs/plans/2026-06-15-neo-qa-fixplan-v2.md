# Neo 两日改造 QA 修复方案 v2（吸收 Codex 对抗验证收敛）

> v1：`2026-06-15-neo-qa-fixplan.md`｜Codex 裁决：`2026-06-15-neo-qa-codex-verdict.md`
> 本版按 Codex 反驳逐条收敛：T3 重做，T1/T2/T4 收敛，T5 维持并补测试。
> 标注 `⚠️待核` 的是 Codex 指出但需实现前在代码里再确认的点，不要当成既定事实直接写代码。

---

## Topic 1 — 隐私防火墙加固（HIGH · 收敛）

### Codex 修正
- 落库风险**不止 `ChannelAttachment.localPath`**：实际持久化字段会变成 `MessageAttachment.path`。粗暴改 attachment persistence 会波及更广。

### 收敛后方案
- **先定位真实落库路径**：确认 `ChannelAttachment` → `MessageAttachment` 的映射点，找到 `path / 各新字段` 在持久化时的真实写入位置（`⚠️待核`：MessageAttachment.path 的赋值处 + metadata 落库点）。脱敏要加在**这个真实边界**上，而不是只改 `sanitizeChannelAttachments`。
- **两条路径都覆盖且不过度**：下发路径（`channelPrivacyFirewall.ts:104-116` 白名单化）+ 持久化路径（MessageAttachment 映射处）各自处理新字段；不要为图省事在 attachment persistence 顶层一刀切，避免影响非 channel 来源的附件。
- **转写时机**：转写产物在注入正文/落库前过 redactor（与文本 ingress 同一套）。
- sanitizer 从「透传 + 覆写」改「白名单构造」：`metadata.transcript` 走 redactor，`localPath/缓存路径` 在 local-redact 下剥离/哈希，`accountId/messageId` 按既有 PII 策略。

### 对称应用
下发 sanitize + MessageAttachment 持久化两条路径都改；各 `ChannelPrivacyMode` 行为都明确。

### 验收测试
- local-redact 下含敏感 `metadata.transcript` 的附件，**落库后的 `MessageAttachment.path` 与 metadata** 与下发内容都已脱敏。
- 含敏感词语音 transcript 持久化后 DB 不含原文。
- 结构守门：`MessageAttachment`/`ChannelAttachment` 新增字段未在两条边界显式处理则测试失败。

---

## Topic 2 — hotkeys 焦点门控（HIGH · 收敛）

### Codex 修正
- **不能把「composer scope 统一加 focus guard」当修法**：blanket guard 会误伤 `composer.focus` 等同 scope 的其它 action。

### 收敛后方案
- **精准到 action，不是到 scope**：门控只加在「裸单字符 / `composer.slashMenu`」这类会与正常输入冲突的 action 上，而非对整个 composer scope 统一拦截。`composer.focus` 等需要全局可触发的 action 保持原行为（`⚠️待核`：枚举 composer scope 下所有 action，确认哪些是"输入冲突型"哪些是"全局功能型"）。
- **判定规则**：对"输入冲突型"裸键，仅在 composer 输入框聚焦 + 输入为空/光标行首时作为命令；否则**不 preventDefault**，让字符正常落。
- **consumer 防丢字**：`ChatInput/index.tsx:231-235` 的 `handleOpenSlashMenu` 不再 `setValue('/')` 覆盖，空输入才插入。
- 与计划文档 `2026-06-14-hotkeys-development-plan.md` L226「按 focus scope 选 action」对齐，但落点是 action 级判定。

### 对称应用
darwin/win32/linux 三平台 + Tauri/web 两 runtime 都修；只改"输入冲突型"action，别动全局功能型。

### 验收测试
- composer 未聚焦按 `/`：事件不被 preventDefault、不触发菜单。
- 输入含 `hello` 时触发：文本不被覆盖。
- composer 聚焦空输入按 `/`：正常打开菜单（保功能）。
- **回归守门**：`composer.focus` 等全局功能型 action 在输入框聚焦时仍可触发（防 blanket guard 误伤）。

---

## Topic 3 — model routing（MED · 重做，原方案 REJECT）

### Codex 驳回的两点
1. "manual 静默送文本模型"**不是全链路事实**：runtime 还有 vision capability 检测 + preflight + adaptive fallback（`inference.ts:1166 / 1203`）。modelDecision 层 manual 确实不选 vision（`modelDecision.ts:496` intent 固定 `coding`），但下游可能仍兜底。
2. "显式模型优先于 auto"**缺实现基础**：`adaptive !== true` 时本就直接返回 user-selected（`modelDecision.ts:486`）；`adaptive === true` 时**没有字段能区分"用户刚手选的模型"与"默认 base config"**。
3. `ModelDecision` contract **没有通用 diagnostics 字段**（`shared/contract/modelDecision.ts:227`），不能笼统"落 diagnostics"。

### 重做方案（先对齐你的两条决策，再给正确实现路径）
你的决策不变：① 默认 auto 保留；② 显式指定模型不被 auto 覆盖；③ manual 无视觉能力时推荐而非静默降级。正确落法：

**A. 先把状态分清（三态优先级）**
- `auto + image` → 走 vision profile（**现状已正确，测试必须锁死不被破坏**）
- `manual + 当前模型有 vision 能力` → 用当前模型，不干预
- `manual + 当前模型无 vision 能力 + 本轮有 image` → **唯一**需要推荐的分支

**B. manual 无视觉能力的推荐（避免与 runtime 重复）**
- `⚠️待核`：先确认 runtime 的 vision preflight/fallback（`inference.ts:1166/1203`）在 manual + 无能力 + 有图时**到底怎么兜底**——是已 fallback 到某 vision 模型，还是真降级文本。
  - 若 runtime 已兜底：问题降级为「无提示」，方案=补一条用户可见提示，**不改路由**。
  - 若 runtime 真降级文本：方案=在 modelDecision 层产出推荐 + 由 runtime 决定是否切。
- 推荐落点：**给 `ModelDecision` 加一个 typed 字段**（如 `recommendation?: { kind: 'vision-model'; suggestedModel; reason }`），不复用不存在的通用 diagnostics。

**C. 显式模型优先（先解决信号源，再谈实现）**
- `adaptive !== true` 已尊重显式选择，无需改。
- 真问题在 `adaptive === true`：`⚠️待核` 必须先确认/引入一个信号来区分「用户刚手选模型」vs「默认 base config」。**没有这个信号前不动 auto 逻辑**——否则按 Codex 警告会打乱 auto 设计。这一条作为前置调研项，调研不出信号源就**暂缓**，只做 B。

### 对称应用
只动 manual 分支与（确认信号源后的）显式优先级；auto 既有 vision 行为零改动。

### 验收测试
- **锁死回归**：auto + image 仍走 vision profile。
- manual + image + 无 vision 能力 → 产出 typed 推荐（指向已配可用 vision 模型），且不与 runtime fallback 重复提示。
- manual + image + 有 vision 能力 → 不打扰。
- （若做 C）adaptive + 用户手选模型 → 不被 auto 覆盖；adaptive + 默认 → auto 正常。

---

## Topic 4 — 硬门并入主 CI（MED · 收敛）

### Codex 修正
- required gate **不能依赖 workflow-level `on.pull_request.paths`**：没命中的 PR 根本不产出 required check，等于静默放行。
- 验收例子「改 locked deliverable 但不触发 gate path」**多数 locked deliverable 本就在 paths 里**，测不出漏洞，要重选。
- "required-as-code"：GitHub 不读普通 YAML 当 branch protection，要么接 ruleset API/Terraform，要么只能叫「documented requirement + CI self-check」。

### 收敛后方案
- **path-filter 下沉到 job 内部**：gate job 在主 `swarm-ci`（或被它 needs）里**总是触发**；是否实跑由 job **内部**判断——需要跑就跑，不需要也**显式输出 pass**，保证每个 PR 都产出 capability/eval gate 这个 required check。
- **required-as-code 诚实表述**：要么接 ruleset API/Terraform 落仓库内；做不到就明确标为「documented requirement + CI self-check」，不假装 YAML = branch protection。

### 对称应用
capability-evidence + eval-harness-gate 两道都下沉并入；用 needs/并行 job 控时长。

### 验收测试
- 重选验收样本：选「真实依赖受锁能力、但**不在旧 paths 里**」的文件改动，或直接断言 `swarm-ci` 必跑 job **总是**产出 capability/eval gate 状态。
- 不需跑的 PR：gate job 仍显式 pass、非 skipped/缺席。

---

## Topic 5 — shellCapabilities 清单对账（技术债 · PASS）

### Codex 结论
最小修法成立，无事实错误；仅测试矩阵可补强。

### 方案（维持）
- `shellCapabilities.ts` 补 5 个 action：PROJECT 加 `artifactIssues/setDescription`，SETTINGS 加 `saveProviderIconAsset/resolveProviderIconAsset`，MEMORY 加 `memoryEntryUpdate`，使 scanner 测试转绿。
- 防再漂移：确认 scanner 测试在主 CI/受锁路径内会跑（与 T4 联动）。

### 验收测试（补强）
- `tests/unit/main/shellCapabilities.test.ts` 转绿。
- 正向对账（手册 action ⊆ 注册 handler）+ **反向对账**（注册 handler ⊆ 手册，防多登记）+ 5 个新 action 各一条命中断言。

---

## 实现就绪度评级
| Topic | 状态 | 能否直接进 /codex-fix |
|---|---|---|
| T5 | ✅ 就绪 | 可以 |
| T1 | 🟡 需先核 MessageAttachment.path 落库点 | 核完即可 |
| T2 | 🟡 需先枚举 composer scope action 分类 | 核完即可 |
| T4 | 🟡 需定 path-filter 下沉的 job 结构 | 核完即可 |
| T3 | 🔴 含前置调研（runtime fallback 行为 + adaptive 信号源） | 调研后再定，C 可暂缓 |

## 下一步给 Codex 的复验指令
只验「收敛是否到位」：① v2 是否纠正了 v1 的 6 条事实错误；② `⚠️待核` 项是否该在实现前先查代码而非拍脑袋；③ T3 三态划分 + typed 字段 + 信号源前置是否成立；④ T4 job 内 path-filter 是否真能保证 required check 总产出。每条给 PASS / 仍需收敛。
