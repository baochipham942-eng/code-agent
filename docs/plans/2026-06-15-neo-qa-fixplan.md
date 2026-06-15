# Neo 两日改造 QA 修复方案（待 Codex 对抗验证）

> 来源：2026-06-15 多模块质检 workflow（40 agent / 15 模块 / 已对抗验证）。
> 本文是**修复方案**，尚未实现。交 Codex 作为反方律师逐 topic 对抗验证：方案是否正确、完整、有无副作用、是否对称应用、验收测试是否真能挡回归。

---

## Topic 1 — 隐私防火墙加固（HIGH，合并原 risk 1+2，同一根因）

### 已验证问题
1. **语音转写绕过脱敏时机**：转写在 `enrichChannelMessage` 内完成，发生在 ingress 脱敏**之后**，raw transcript 未脱敏即注入正文 → 经 `sanitizeAttachmentForPersistence` 落本地 SQLite → 下发模型。违反 `channel.ts:195` local-redact 默认契约。无测试。
2. **契约新字段绕过 sanitizer**：本批给 `src/shared/contract/channel.ts:91/93/95` 新增 `localPath / platformFileKey / metadata` 三个 **optional** 字段；`src/main/channels/privacy/channelPrivacyFirewall.ts:104-116` 的 `sanitizeChannelAttachments` 用 `{...attachment}` 透传后只覆写 name/url/thumbnailUrl/data，三个新字段（含 `metadata.transcript`、本地缓存路径、accountId）原样穿过 local-redact。因字段 optional，typecheck 全绿掩盖缺口。

### 修复方案
- **脱敏时机**：把转写产物纳入脱敏链。在 transcript 生成后、注入正文/持久化前，统一过一遍现有 redactor（与文本 ingress 同一套规则），而不是在 enrich 阶段旁路。
- **sanitizer 白名单化**：把 `sanitizeChannelAttachments` 从「透传 + 覆写已知字段」改为**显式白名单构造**——只挑明确安全的字段输出，新字段默认不落地或先脱敏。`metadata` 按 key 逐项处理：`transcript` 走 redactor，`localPath/平台缓存路径` 在 local-redact 模式下剥离或哈希，`accountId/messageId` 按既有 PII 策略处理。
- **防回归结构**：给 `ChannelAttachment` 的 sanitize 加「新增字段必须显式决策」的编译期或测试期保障（见验收）。

### 对称应用检查点
- `sanitizeAttachmentForPersistence`（持久化路径）与 `sanitizeChannelAttachments`（下发路径）两条都要覆盖新字段，别只改一条。
- 各 `ChannelPrivacyMode`（local-redact / 其它模式）下行为都要明确，不能只改默认模式。

### 验收测试
- 单测：local-redact 模式下，含 `metadata.transcript=含邮箱/卡号`、`localPath` 的附件，经两条 sanitize 后字段被脱敏/剥离。
- 单测：含敏感词的语音 transcript，持久化后的正文与 DB 记录不含原文。
- **结构守门**：`ChannelAttachment` 新增字段时若未在 sanitizer 显式处理则测试失败（Object.keys 对账，仿 capability-scanner 模式）。

---

## Topic 2 — hotkeys 焦点门控（HIGH）

### 已验证问题
`composer.slashMenu`（`src/shared/keybindings/actions.ts:87-96`，scope='composer'，enabledByDefault，默认裸键 `/`）由 `src/renderer/hooks/useKeyboardShortcuts.ts` 的 **document keydown 全局监听**触发。dispatch（L482-510）只对 `scope==='global'` 做 native bypass，**composer scope 无任何 focus/scope 门控**：`runAction` 里 composer.slashMenu 分支（L332-334）未走其它 action 都用的 `isInputField` 判断，直接 `preventDefault + stopPropagation`。
后果：① 裸 `/` 在全 app 任何输入框都打不出（URL/路径/`and/or`/`06/15`/正则）；② consumer `ChatInput/index.tsx:231-235` 的 `setValue(current => current.startsWith('/') ? current : '/')` 会把非 `/` 开头的已输入文本整体覆盖丢失。Web 构建同样中招。无测试。
与计划文档 `docs/plans/2026-06-14-hotkeys-development-plan.md` L58/L67-68/L226「按 focus scope 选择 action」**直接冲突**——实现没做 focus-scope dispatch。

### 修复方案
- **按 scope 做 focus 门控**：dispatch 层对 `scope==='composer'` 的 action，仅在「composer 输入框聚焦」时才触发；非聚焦时**不拦截、不 preventDefault**，让 `/` 正常落字符。复用现成 `isInputTarget/isInputField`，与 dag.toggle/workspace.toggle 等已有用法对齐。
- **裸单字符二次约束**：bare single-char hotkey 仅在 composer 聚焦且**输入框为空或光标在行首**时作为「打开 slash 菜单」语义；否则按普通字符输入。避免「输入到一半敲 /」被吞。
- **consumer 防丢字**：`handleOpenSlashMenu` 不再 `setValue('/')` 覆盖，改为仅在空输入时插入，非空时不动已有文本。

### 对称应用检查点
- 其它 composer scope 的可配置裸键（若有）走同一门控，不要只特判 `/`。
- darwin/win32/linux 三平台默认键一致处理；Tauri 与 web 两种 runtime 都要修（当前 break 在所有 runtime）。

### 验收测试
- 单测/集成：composer 未聚焦时按 `/`，事件不被 preventDefault，action 不触发。
- 单测：输入框含 `hello` 时触发 slashMenu，文本不被覆盖。
- 单测：composer 聚焦且空输入时按 `/` 正常打开菜单（保留正向功能）。

---

## Topic 3 — model routing 决策细化（MED，方向已定）

### 已验证问题 + 用户决策
- `src/main/model/modelDecision.ts:497-502`：`manual` 模式硬编码 intent='coding'、profile=default('main')，**完全跳过 `inferStrategyIntent`**；而 `inferStrategyIntent`（259-274，hasVisionInput@263）是**唯一**会因图片输入路由到 `vision` profile 的路径。→ manual 模式下带图请求被丢给文本模型，视觉能力静默失效。
- 默认 `auto` 全局改变既有用户模型路由，触及 ADR-019 计费门控。

**用户决策**：
1. 默认 `auto` 保留**不变**。
2. 但**用户在设置页显式指定了特定模型**时，不被 auto 路由覆盖——尊重显式选择。
3. `manual` 模式下若当前模型**无视觉能力**而本轮有图片输入，**主动推荐用户切换到已配置的可用视觉模型**，而非静默降级到文本模型。

### 修复方案
- **显式模型优先级**：在路由决策入口加一层——若用户设置存在「显式指定模型」（非 auto/非空），该指定优先于 auto 推断结果，auto 仅在用户未显式指定时生效。需定位设置项真实来源字段并以其为准。
- **manual + vision 推荐**：manual 分支检测 `hasVisionInput && 当前 resolved 模型不具备 vision capability` 时，不再静默走文本模型，而是：(a) 查已配置 providers 里是否有可用 vision 模型；(b) 有则产出一条**推荐/提示**（UI 可感知，复用现有 decision/diagnostics 通道），让用户确认切换；(c) 在用户未切换前的兜底行为需明确（建议：提示优先，不擅自改路由）。
- 推荐逻辑要落到 `modelDecision` 的 diagnostics/decision 输出，便于 renderer 呈现。

### 对称应用检查点
- auto 分支本就尊重 vision，本次只动 manual 分支与「显式指定」优先级，别破坏 auto 既有行为。
- 「显式指定模型」判断在 fast/main/deep/vision 各 profile 槽位都要一致。

### 验收测试
- 单测：设置页显式指定模型时，auto 推断不覆盖该指定。
- 单测：manual 模式 + 图片输入 + 当前模型无 vision → 产出推荐（且不静默路由到文本 vision 缺失槽）。
- 单测：manual 模式 + 图片 + 已配可用 vision 模型 → 推荐内容指向该模型。

---

## Topic 4 — 硬门并入主 CI（MED）

### 已验证问题
能力证据硬门（`scripts/check-capability-evidence.ts` + `.github/workflows/capability-evidence.yml`）与运行证据硬门（eval mock 晋升拒绝 + `eval-harness-gate.yml`）**逻辑本身真生效、绕不过**，但二者是 **path-filtered 独立 workflow，未并入主 `swarm-ci`**，且仓库无 branch-protection-as-code。含义：PR 只要不触碰那几个精确路径就被 path-filter 静默放行，且「是否设为 required check」依赖 GitHub 仓库设置（不可见于代码）。

### 修复方案
- **并入主 CI**：把能力/运行证据 gate 作为 job 纳入主 `swarm-ci`（或让主 CI 依赖其结果），使其在所有 PR 上至少执行判定，而非仅 path 命中时。
- **覆盖面**：保留 path-filter 做快路径优化，但增加一条「受锁能力清单变更检测」——若 PR 改动了受锁能力涉及的实现/测试但未触发 gate 路径，仍强制跑 gate。
- **required-as-code**：把关键 gate 设为 required status check 的配置尽量落到仓库内可见处（如 ruleset/branch-protection 配置文件或文档化 + checklist），减少「靠 GitHub 设置」的不可见依赖。

### 对称应用检查点
- 两道门（capability-evidence、eval-harness-gate）都要并入，别只并一道。
- 不要因并入导致主 CI 时长爆炸——评估用 needs/并行 job 而非串行。

### 验收测试
- 改一个受锁能力的交付物使其不达标，提一个**不触碰 gate path** 的 PR，验证主 CI 仍 fail。
- gate job 在主 CI 的 run 记录可见、非 skipped。

---

## Topic 5 — shellCapabilities 清单对账（技术债）

### 已验证问题
`renderer-capability-scanner` 实跑 FAIL，5 个 handler 已注册但未登记到 `CAPABILITY_DOMAIN_ACTIONS`：`project/artifactIssues`、`project/setDescription`、`settings/saveProviderIconAsset`、`settings/resolveProviderIconAsset`、`memory/memoryEntryUpdate`，横跨 4 个 commit。`tests/unit/main/shellCapabilities.test.ts` 首用例当前**已红**。运行时 IPC 不受影响（不经此网关），但声明这些 `requiredShellCapabilities` 的 renderer 热更新 bundle 会被误拒。

### 修复方案
- **补登记**：在 `src/main/shellCapabilities.ts` 对应域补齐 5 个 action（PROJECT 加 artifactIssues/setDescription，SETTINGS 加 saveProviderIconAsset/resolveProviderIconAsset，MEMORY 加 memoryEntryUpdate），使 scanner 测试转绿。
- **防再漂移**：scanner 测试已能兜底，确认它在主 CI/受锁路径内会被执行（与 Topic 4 联动）；考虑把「注册 handler 时强制登记 capability」做成更靠前的约束（codegen 或 lint）。

### 对称应用检查点
- 5 个一次补齐，别只补本批新增的 artifactIssues 而漏掉更早 4 个。
- 补登记后核对是否有**多登记**（manifest 有但 handler 不存在）的反向漂移。

### 验收测试
- `tests/unit/main/shellCapabilities.test.ts` 转绿（numFailedTests:0）。
- 反向对账：manifest 中每个 action 都有对应注册 handler。

---

## 给 Codex 的对抗验证指令
逐 topic 充当反方律师，对每条**修复方案**质询：
1. 方案是否真能修掉已验证问题，有没有看错根因？
2. 有没有引入新副作用 / 破坏正向功能（尤其 Topic 2 别把 slash 菜单修没了、Topic 3 别破坏 auto 既有 vision）？
3. **对称应用**是否完整——同一字段/逻辑的所有路径、所有 mode/平台/runtime 都覆盖了？
4. 验收测试是否真能挡住回归，还是只测了 happy path？
5. 有没有更简单或更正确的修法？
对每条给 PASS / 收敛建议 / REJECT(+理由)。
