# ADR-030 — Fleet 遥测双通道设计（Sentry 错误通道 + Supabase 分析通道）

- 状态: proposed
- 日期: 2026-06-28
- 相关: [[ADR-020]]（Telemetry 可诊断性：版本指纹 + 失败 session 上报 + 诊断包）、`code_agent_distribution_architecture`、`project_neo_shared_relay_provider`

## 背景：我们对最该观测的那批用户是瞎的

一次线上排查（同事用 Neo 生游戏报错，云端查不到）暴露出遥测的结构性盲区：

1. **Supabase fleet telemetry 上传硬依赖运行时活跃登录会话。** `telemetryUploaderService.upload()` 第一段即 `const user = getAuthService().getCurrentUser(); if (!user) return 0;`——在推送任何数据之前就返回。
2. **调模型与传遥测走两套不同鉴权。** 共享中转（shared_relay）key 在某次登录时被下发并写入本地 SecureStorage，成为 `custom-*` 托管 provider；此后调模型只读本地缓存 key，**不需要运行时活跃会话**。于是同事「登录一次拿到 key → 长期不再保持登录态 → 仍能调模型」。
3. **结果（已实证）：** 4 个 shared_relay 真人用户中，3 个真同事（bitsqiu / aspcoolqgf / yolaucn）**全维度零遥测**——sessions / turns / renderer_bundle_attempts / diagnostic_bundles 一条都没有。"全维度零"正是 `upload()` 卡在 `if(!user) return 0` 提前返回的指纹（对照管理员账号有活跃会话时各表正常上传）。`profiles.last_active_at` 也停在 6 月初，印证其 app 长期无活跃会话。
4. **Sentry 当前只抓 crash / 未捕获异常**（`captureException` 仅在 `lifecycle.ts` + `crashMarker.ts`），handled 的工具/业务报错不进 Sentry。

净效果：**我们最想拿数据的 fleet 用户（共享 key 同事），恰恰一条信号都收不到。** 这不是用户操作问题，是 auth-gate 设计与共享中转使用形态的错配。

### 为什么不能「把 gate 放宽到有缓存身份即可」

Supabase 写入以登录用户身份走 RLS（`auth.uid() = user_id` 的 INSERT 策略），**没有有效 JWT 就插不进去**（PostgREST 401/403）。客户端刻意不带 service role（安全前提）。所以「只拿缓存 user_id 盖上去直接写」在 RLS 下不成立——要么变成「续期出有效会话」，要么削 RLS（安全倒退，否决）。

## 决策：两条互补通道，作为一个遥测设计

遥测不是单点，而是**两条职责不同的通道**，各管一段，缺一条都瘸。

| 通道 | 职责 | 鉴权 | 回答 |
|---|---|---|---|
| **错误通道（Sentry）** | 实时报错、聚合、告警 | 不依赖登录（DSN 即可） | 什么炸了 / 多频 / 谁炸的（tag） |
| **分析通道（Supabase fleet telemetry）** | 结构化 session→turn→tool、token/成本/成功率 | 要活跃会话（RLS） | 那次到底怎么炸的（完整复盘下钻） |

错误通道给「哪儿冒烟」的即时信号；分析通道把那次会话**还原出来**做根因。两条合起来才叫遥测。

### 通道一 — 错误通道（Sentry）

- **范围**：handled 的工具执行失败 + agent loop 关键异常，经 `captureException` / `captureMessage` 上报；保留现有 crash 捕获。
- **落点**：`src/host/agent/runtime/toolExecutionErrorHandler.ts`（工具失败）、`agentLoop` / `runFinalizer` 的异常收口处。复用已存在的 `setSentryNodeRuntimeTagProvider`（sessionId / model / agentVersion 作为 tag）。
- **脱敏**：复用 `scrubEvent` / `scrubString`（已在 `beforeSend` 接线，永不含源码 / prompt / key / 家目录）。
- **必须配套——错误分级 allowlist（成败关键，非可选）**：工具报错过半是良性的（grep 未命中、file-not-found 后 agent 自恢复）。只上报**真正可执行**的 `errorCategory`（工具执行失败且未被 agent 兜底）。无 allowlist = 刷爆配额 + 淹没信号。
- **采样**：对高频同类错误做 client 端速率限制 / 采样，控配额。
- **opt-out**：沿用 `crashReporting.enabled`（`setCrashReportingEnabled`）；用户关 = 静默 no-op。

### 通道二 — 分析通道（Supabase，修 auth gate）

> **as-built 修正（2026-06-28 读码后）**：原假设「加静默续期」是重复造轮子——客户端**已配** `autoRefreshToken:true + persistSession:true +` electron-store storage adapter，session 本就跨重启持久 + 自动刷新。真正的缺口不在「没有刷新」，而在下面三处。

- **缺口 1 — fail-silent 清用户（核心）**：`authService.validateSessionInBackground()` 在 `getSession()` 返回 null（session 死/过期）时**默默清掉缓存用户**（authService.ts:203-209），既不提示也不留信号 → `getCurrentUser()` 变 null → uploader 的 auth 门静默挂掉。**修法**：检测到「有缓存身份但 session 不可恢复」时，发非阻塞提示「登录已过期，点一下重连」，**禁止**默默清零。
- **缺口 2 — auth-skip 不可观测**：`upload()` 在 `if(!user) return 0` 处静默返回。**修法**：该 skip 落一条带原因的日志/指标，让"为什么没上传"可见（不再靠人肉 SQL 反推）。
- **缺口 3 — Keychain 持久化是死代码（潜在 bug）**：未设 `storageKey`，supabase-js 默认用 `sb-<ref>-auth-token`，而 storage adapter 的 Keychain 特例只认 `'supabase.session'` → `saveSessionToKeychain`/`getSessionFromKeychain` 整段从不触发，session 只在 electron-store，**重装/重置数据目录即丢登录**。**修法**：不改 `storageKey`（会让现有用户 session 换键 → 全员强制重登一次），而是把 adapter 那三处 `key === 'supabase.session'` 判断改成 `isSupabaseSessionKey(key)`（匹配真实默认键 `sb-*-auth-token`）→ Keychain 存活路径真正生效，且**零强制登出、自愈**。
- **硬约束（绕不过）**：RLS 写遥测需有效 JWT；refresh token 真过 TTL 时，除重新登录无他路——所以缺口 1 的「重连提示」是兜底终点，不是可选项。
- **不做**：不投机重写已存在的刷新逻辑（auth 高风险区，且深层「为何 refresh 失败」需同事机器才能定，本轮不赌）。
- **数据形态不变**：维持现有 metadata-only 结构化设计（模型 / 延迟 / token / 报错码 / 工具名；payload 不含 prompt/completion/入参）。

### 通道边界（两条别打架）

- **错误串两边都会出现**，但都走 `scrubEvent` 脱敏，不重复堆全 payload。
- **Sentry** = 脱敏错误事件 + tag + 采样 + allowlist（只上可执行报错）。
- **Supabase** = metadata-only 结构化（设计不变），管事后归因。
- 一条管「立即发现」，一条管「事后复盘」，不互相替代、不重复全文。

## 顺序与依赖

1. **先做错误通道（Sentry）**：不依赖登录 = 立刻覆盖 100% 用户（含缓存 key 同事）；改动小、爆炸半径小（只在 error 落点补 capture + allowlist + 采样，不碰 auth / RLS / 协议）。**它先上，是因为分析通道在建和验证期间，Supabase 对同事仍然是瞎的——错误通道让你在分析通道还没好时就有信号。**
2. **再做分析通道（会话续期）**：续期登录逻辑失败面更大、需同事侧验证，押后。它救回的是结构化分析（Sentry 给不了）。

## 后果

- **收益**：对全 fleet（含不保持登录的共享 key 同事）拿回错误可见性；分析通道修复后拿回完整会话取证；两条职责清晰不重叠。
- **代价 / 风险**：
  - Sentry 配额：靠 allowlist + 采样控制；上线后观察事件量再调阈值。
  - refresh token TTL：可能已过期，续期失败需 re-login 兜底（已设计）。
  - opt-out 必须尊重：两通道都受用户开关控制，关闭即 no-op。

## 验证口径（怎么确认同事侧真收到）

- **错误通道**：构造一个 allowlist 内的工具失败 → Sentry dashboard 出现事件 + 正确 tag（sessionId/model）；脱敏断言（无源码/prompt/家目录）；匿名 / 未登录态也能上报。
- **分析通道**：模拟「有缓存身份 + 无活跃会话」启动 → 续期成功后 telemetry 各表恢复写入；refresh token 失效路径触发 re-login 提示而非静默零传；以一个真同事账号验证云端从此有 sessions/turns。

## Deferred / Open

- 错误通道的 allowlist 初版按现有 `errorCategory` 枚举落，上线后据真实分布迭代。
- 是否给同事一个「一键打包本地日志」入口（在续期方案落地前，本地日志仍是唯一兜底）——待定，不在本 ADR 范围。
