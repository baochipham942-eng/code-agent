# v0.30.0 真机缺陷修复批 P0 报告

基线：`240f28ed9e3961cc7ccfe18b80b7d610991ea86f`

范围：仅 F1 / F2 / F3 / F4。未 push、未开 PR、未触碰 `~/.code-agent` 或 `/Applications/Agent Neo.app`。

## F1：402 欠费误报授权问题

### 根因

host `errorClassifier` 已把 HTTP 402 归为 `quota_exhaustion`，renderer 的 `classifyAgentError` 却维护另一套规则，把 `insufficient`、`quota`、余额、欠费等信号统归 `auth`。会话错误卡消费 renderer 结论，因此精确的 402 被降级成密钥/授权猜测。

### 改动文件

- `src/shared/utils/providerError.ts`
- `src/shared/contract/message.ts`
- `src/host/model/errorClassifier.ts`
- `src/renderer/hooks/agent/effects/useSessionLifecycleEffects.ts`
- `src/renderer/components/features/chat/AgentErrorCard.tsx`
- `src/renderer/i18n/agentError.ts`
- `tests/unit/model/errorClassifier.test.ts`
- `tests/renderer/hooks/useSessionLifecycleEffects.errorState.test.ts`
- `tests/renderer/components/agentErrorCard.test.tsx`

提交：`fc22ae119 fix(errors): distinguish insufficient balance from auth`

### 测试与变异证据

- 红测：402/明确余额信号仍得到 `auth`，欠费卡仍落 generic 文案，共 2 条失败。
- 修复：host 与 renderer 共用明确余额判据；renderer 新增 `insufficient_balance`。402/明确余额给出“这个账号余额不足”“去供应商后台充值后即可继续”，只展示“检查账号设置”；401 Invalid API Key 保持 `auth` 兜底。
- 定向套件：3 files，85 passed / 0 failed / 0 skipped。
- 变异：临时把欠费分支改回 `auth`，`classifies HTTP 402 and explicit balance failures as insufficient_balance` 转红；恢复后 85 passed。

### 证据档位

Hermetic：分类器、结构化 metadata、i18n 文案和按钮动作均由单测覆盖。

### 未尽事项

- 需监工用真实 402 供应商响应做 real-runtime 验收，确认 host 事件载荷保留 HTTP 状态并展示新卡片。

### 监工复核补充：credit 覆盖收敛回归

监工复核发现，首轮共享判据替换了 host 原有正则中的裸 `credit` 分支，却只覆盖 `insufficient credit` 形态，导致三类明确余额语义从 host `quota_exhaustion` 和 renderer `insufficient_balance` 同时漏出：

- `Your credit balance is too low to access the Anthropic API`
- `You have run out of credits`
- `This request would exceed your credit limit`

修复在共享判据中补入受限的 credit 余额模式：credit balance 过低、credits 用尽、credit limit 超限。没有恢复裸 `credit`，并用 `Please update your credit card details` 负例锁定无关信用卡文案不得命中。

- 红测：上述三条文案分别在 host 与 renderer 转红，共 6 failed；两条 `credit card` 负例保持通过。
- 变异：临时撤销新增 credit 分支与 `too low` 支持，同 6 条正向断言再次转红；恢复后全绿。
- 受影响套件全量：3 files，93 passed / 0 failed / 0 skipped。
- `npm run typecheck`：通过。

## F2：实时语音总开关默认开启

### 根因

`DEFAULT_SETTINGS` 没有 `voice.live.enabled`，全新目录与未写过该字段的配置最终都得到 `undefined`，没有落实产品已拍板的“未配置即开启”。

### 改动文件

- `src/shared/contract/settings.ts`
- `src/host/services/core/configDefaults.ts`
- `tests/unit/services/core/configService.voiceLiveDefaults.test.ts`

提交：`6f1872f5a fix(voice): enable realtime voice by default`

### 测试与变异证据

- 红测：全新临时数据目录读取到 `undefined`，1 failed / 1 passed；显式 `enabled:false` 原本即可保留。
- 修复：增加 `VOICE_LIVE_ENABLED_DEFAULT = true`，并写入 host 默认设置。递归合并只补 `undefined`，显式 false 不被覆盖。
- 配置相关套件：4 files，9 passed / 0 failed / 0 skipped。
- 变异：临时把默认常量反改为 false，全新目录测试转红，显式 false 测试继续通过；恢复后 2 passed。

### 证据档位

Hermetic：使用隔离临时数据目录覆盖首启与存量显式关闭后的初始化/持久化路径。

### 未尽事项

- 需监工在全新 Dev 8181 数据目录首启确认入口可见，再显式关闭并重启确认保持隐藏。

## F3：缺 key 时实时语音入口消失

### 根因

缺 key 状态本身没有在 `LiveVoiceButton` 内吞入口：该组件已有 `configured:false` 的弱化入口、角标和引导层。真正的截断发生在它上游：`useVoiceLiveAvailability` 用 `settings.voice?.live?.enabled === true` 读取总开关，把 legacy/部分设置中的 `undefined` 判成 false；随后 `resolveComposerCoreActions` 在按钮渲染前选择 Send，降级分支根本没有挂载。设置页还复制了同一份 `=== true` 语义。

### 消费入口对齐

- `src/web/routes/voice.ts`：只从 secure storage/env 产出所选实时语音 Provider 的 `configured` 真相，不参与总开关判定。
- `src/renderer/components/features/voice/useVoiceLiveAvailability.ts`：总开关统一走 `resolveVoiceLiveEnabled`；key 状态独立保留为 `configured`。
- `src/renderer/components/features/chat/ChatInput/index.tsx`：主操作位只看总开关，不用 `configured` 隐藏入口。
- `src/renderer/components/features/voice/LiveVoiceButton.tsx`：`configured:false` 进入弱化引导，不拨号；只有显式总开关 false、无会话或非 idle 相位才不渲染。
- `src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection.tsx`：总开关展示与入口使用同一默认解析函数。
- `VoiceApiKeyConfig` / `VoiceModelSettings`：`configured` 只用于 key 编辑和 Provider 状态展示，不控制 composer 入口存在性。

### 改动文件

- `src/shared/contract/settings.ts`
- `src/renderer/components/features/voice/useVoiceLiveAvailability.ts`
- `src/renderer/components/features/settings/tabs/VoiceLiveSettingsSection.tsx`
- `tests/renderer/hooks/useVoiceLiveAvailability.test.tsx`
- `tests/renderer/components/voiceLiveSettingsSection.test.tsx`

提交：`1a9e6d174 fix(voice): preserve no-key realtime entry`

### 测试与变异证据

- 红测：设置存在但省略 `enabled`、host status 返回 `configured:false` 时，availability 得到 `{ enabled:false, configured:false }`，入口在降级前被吞；1 failed / 1 passed。
- 修复：新增统一解析函数，语义为 `undefined → true`、显式 `false → false`；availability 初始值和异步刷新、设置页初始值和载入值全部对齐。
- 实时语音相关套件：7 files，68 passed / 0 failed / 0 skipped。
- 变异：临时把解析函数反改为 `enabled === true`，缺 key + 未写 enabled 的入口测试转红；恢复后 68 passed。

### 证据档位

Hermetic：覆盖 IPC 设置返回、host status 缺 key、composer slot、按钮降级引导、key 配置页和设置页状态。

### 未尽事项

- 需监工在 Dev 8181 清除 DashScope key 后刷新，确认弱化入口与角标在、点击只弹配置引导且不拨号。

## F4：image_process 尺寸不符仍报成功

### 根因

`resize` 使用 Sharp `fit: inside` 与 `withoutEnlargement:true`，它保证图片落在目标边界内并保持宽高比，不保证同时命中请求宽高。实现虽然在写盘后读取了真实 metadata，却无条件返回 `ok:true` 和“✅ 图片处理完成”。

### 改动文件

- `src/host/plugins/builtin/imageProcess/imageProcess.ts`
- `src/host/plugins/builtin/imageProcess/imageProcess.schema.ts`
- `tests/unit/tools/modules/network/imageProcess.test.ts`

提交：`bf26b1ed4 fix(image): fail loudly on resize mismatch`

### 测试与变异证据

- 红测：输入 2912×1920、请求 1080×1920、实际 1080×712 时旧实现仍 `ok:true`；1 failed / 18 passed。
- 修复：任何已指定边长与实际 metadata 不一致时返回 `OUTPUT_DIMENSION_MISMATCH`，错误明确列出请求、实际与 `fit: inside` 语义，不产生 ✅ 成功文案。已写出的文件路径随失败结果返回，避免把可用产物静默丢掉。
- 定向套件：1 file，19 passed / 0 failed / 0 skipped。
- 变异：临时移除 width/height mismatch 闸，新增 mismatch 测试转红；恢复后 19 passed。

### 证据档位

Hermetic：Sharp metadata、文件状态与输出文本通过隔离 mock 覆盖。

### 未尽事项

- 当前选择 fail-loud，不做 pad/crop。若产品需要强制精确画布尺寸，应另立语义明确的 fit/pad/crop 参数，不能复用当前 resize 承诺。

## 完工门

- 去重后的受影响测试全量：14 files，179 passed / 0 failed / 0 skipped。
- `npm run typecheck`：通过。
- `git diff --check`：通过。
- 证据范围：本轮全部为 hermetic；F1/F2/F3 的真实供应商/桌面 Dev 8181 验收留给监工。
