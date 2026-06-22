# Handoff: MiMo-Code / Kimi Code 引擎接线清单

> 来源分支：`feat/engine-mimo-kimi` · 计划：`docs/plans/engine-expansion-mimo-kimi.md` §2/§5
> 状态：adapter + 类型 + 分发已实现并测试通过；**registry / model-catalog 两个热点文件刻意未改动**，
> 等地基①②会话重写完后按本清单接线，避免合并冲突。

## 已完成（本分支，无需地基会话再动）

- `src/shared/contract/agentEngine.ts`：`AgentEngineKind` + `AGENT_ENGINE_KINDS` 已含 `mimo_code` / `kimi_code`
- `src/main/services/agentEngine/agentEngineGuards.ts`：`isExternalAgentEngine` 已认这两 kind
- `src/main/services/agentEngine/agentEngineModelDecision.ts`：`isExternalEngineKind` 已认这两 kind
- `src/main/services/agentEngine/mimoCliAdapter.ts`（新）：`MimoCliAdapter` + `buildMimoArgs` + `parseMimoJsonLine`
- `src/main/services/agentEngine/kimiCliAdapter.ts`（新）：`KimiCliAdapter` + `buildKimiArgs` + `parseKimiJsonLine`
- `src/main/services/agentEngine/index.ts`：已导出两个新 adapter
- `src/main/app/agentAppService.ts`：`sendMessage` 已加 `mimo_code` / `kimi_code` 两个分发分支
- 4 个 renderer 文件（`streamEventNormalizers.ts` 的 `EXTERNAL_AGENT_ENGINE_KINDS` Set + 3 个 `Record<*Kind>` UI 标签/图标映射）已补两 kind
- 测试：`tests/unit/agentEngine/mimoCliAdapter.test.ts`、`tests/unit/agentEngine/kimiCliAdapter.test.ts`（共 21 测，全绿）

## ⚠️ 当前运行时缺口（必须由地基②补齐才能真正可跑）

`agentEngineRegistry.ts` 的 `list()` 目前只产出 `native / codex_cli / claude_code` 三个 descriptor。
adapter 在 `registry.get('mimo_code')` / `registry.get('kimi_code')` 处会拿不到 descriptor，
现状会抛 `Unknown agent engine: mimo_code`。**这是预期的待接线状态**，不是 bug。
真正可跑前，地基② 必须在 registry 注册这两个引擎的 descriptor + PATH 探测。

## 地基②（PATH 发现 + fail-closed）需要在 `agentEngineRegistry.ts` 加什么

1. `list()` 里追加两个 descriptor，与 `detectCodex` / `detectClaude` 同构：
   - `detectMimo(detectedAt)`：探活 `mimo`，version 探活 `mimo --version`；env 覆盖 `MIMO_BIN`
   - `detectKimi(detectedAt)`：探活 `kimi`，version 探活 `kimi --version`；env 覆盖 `KIMI_BIN`
2. descriptor 字段建议（与 codex/claude 对齐）：
   - **mimo_code**
     - `label: 'MiMo-Code'`
     - `command: 'mimo run --format json'`
     - `defaultPermissionProfile: 'read_only'`，`cwdPolicy: 'workspace_only'`，`riskTier: 'medium'`
     - `installState`：探到 binary 且 `--version` 成功 → `'installed'`，否则 `'missing'`
     - `executable`：同 `installState === 'installed'`（adapter 闸门检查 `!executable || installState !== 'installed'`）
     - `capabilities`：installed 时 `['execute', 'stream_events', 'import_sessions', 'review']`，否则 `['import_sessions']`
     - `reliability.streamingMode: 'json'`（MiMo 是 `--format json` 事件流，非 stream-json）
   - **kimi_code**
     - `label: 'Kimi Code'`
     - `command: 'kimi -p --output-format stream-json'`
     - 其余同上，但 `reliability.streamingMode: 'stream_json'`
3. **fail-closed**：会话级 pin 了某引擎但探测不可用时必须 throw，绝不静默降级（计划 §5②）。
4. **Kimi 凭据隔离（per-user KIMI_CODE_HOME）**：adapter 已支持 `KimiCliRunRequest.kimiCodeHome`
   注入每会话/每用户的凭据目录（Kimi CLI **不读 env API key**，靠该目录下 `kimi login` 落盘 /
   `config.toml`）。地基② 若负责派生 per-user 凭据目录，请把它通过分发处传进 `kimiCodeHome`。
   对应接线点：`src/main/app/agentAppService.ts` 的 `kimi_code` 分支（已留 TODO 注释）。

## 地基①（兼容矩阵 / 计费）需要在 `agentEngineModelCatalog.ts` + 矩阵加什么

1. `EXTERNAL_AGENT_ENGINE_KINDS` Set（`agentEngineModelCatalog.ts` 顶部）加入 `'mimo_code'`, `'kimi_code'`，
   否则 `parseEngine` 会把这两 kind 的 catalog 条目判为 `invalid_engine_kind` 丢弃。
   （本分支刻意未改此 Set，避免与地基①重写冲突。）
2. 在签名 model catalog 里登记两个引擎的模型条目（`kind` / `defaultModel` / `models[]`）：
   - **mimo_code**：登记 MiMo 暴露的编码模型（如 `mimo-coder` 等，按真实 CLI `--model` 取值）
   - **kimi_code**：登记 Kimi 会员订阅可用模型（如 `kimi-k2.5` 等，按真实 `-m` 取值）
3. 计费模式列（计划 §5① 请矩阵预留）：两者都是「订阅/账号额度」而非 API key PAYG。
4. catalog 接线后，把 `agentAppService.ts` 两个分支里的 `model: launch.model` 改回
   `model: await getRemoteAgentEngineModelCatalogService().resolveModelId('mimo_code'|'kimi_code', launch.model)`
   （现在直传是因为未注册 kind 经 `resolveModelId` 会返回 undefined 丢掉用户选择）。

## 接线点速查（agentAppService.ts，已实现，注释里有 TODO 锚）

- `mimo_code` 分支：`model: launch.model` ← 待地基① catalog 就绪后改走 `resolveModelId`
- `kimi_code` 分支：`model: launch.model` ← 同上；`kimiCodeHome` ← 待地基② per-user 凭据目录派生
