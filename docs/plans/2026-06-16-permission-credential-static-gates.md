# 权限确认 / 凭据存储 / 静态门 加固实施计划

> 日期: 2026-06-16
> 作者: Neo (Agent)
> 状态: 待执行
> 前提: 用户不读代码、不做人工 review。**质量完全由验证闸门保证**——本文档的核心是每一步可执行、可留证据的验证计划。任何步骤如果验证不通过，不得进入下一步。

---

## 1. 目标与范围

### 1.1 目标

基于 2026-06-16 现状摸底，三个域已有大量生产级实现，本计划只补齐缺口、不重写已稳态模块。

| 域 | 现状 | 本计划动作 |
|----|------|-----------|
| 权限确认 UI | Escape 已禁用、双层记忆已实现（生产级） | **不动逻辑**；仅把自由字符串 `reason` 枚举化（可追溯、可测试、可 i18n），UI 渲染向后兼容 |
| 凭据存储 | fail-closed + AES-256-GCM + Keychain 三层（生产级） | **不动加密逻辑**；补一个回归测试锁住 fail-closed 与掩码 round-trip 不被未来改动破坏 |
| 静态门 | 仅 typecheck + vitest，无 console/a11y/stale-dist 检查，lint 脚本孤立未接 CI | 新增 4 个静态门脚本并接入 CI：console-scan、a11y-scan、stale-dist-scan、lint 接入 |

### 1.2 范围边界（明确不做）

- **不**重构 confirmationGate 的 `shouldConfirm` / `assessRiskLevel` 风险评估逻辑。
- **不**改 secureStorage 的加密算法、key 派生、fallback 链。
- **不**改 permissionStore 记忆键生成粒度。
- **不**引入重型 a11y 框架（Pa11y/Lighthouse CI 启浏览器），首版用轻量静态规则脚本，避免拖慢 CI。

### 1.3 共享类型 / 协议改动清单（需对抗审查）

只有一处触及共享契约：`PermissionRequestReason` 枚举加入 `src/shared/contract/permission.ts`。该文件被 main 与 renderer 双侧引用，属于跨进程契约改动，**必须走 /multi-review 或 codex-audit**（见步骤 1 验证计划）。

---

## 2. 涉及文件锚点 (file:line)

```
权限确认（步骤 1）:
  src/shared/contract/permission.ts:59          reason?: string  → 改为 reason?: string（保留）+ 新增 reasonCode?: PermissionRequestReason
  src/main/agent/confirmationGate.ts:92         shouldConfirm()
  src/main/agent/confirmationGate.ts:122        buildPreview() — 产生 reason 文案处
  src/main/agent/confirmationGate.ts:263        assessRiskLevel()
  src/renderer/components/PermissionDialog/types.ts:58   本地 reason 类型
  src/renderer/components/PermissionDialog/PermissionCard.tsx:190-194  Escape 拦截（仅读，不改）
  src/renderer/components/PermissionDialog/PermissionCard.tsx:231-233  reason 渲染处
  src/renderer/stores/permissionStore.ts:77-113 getMemoryKey（仅读，不改）

凭据存储（步骤 2）:
  src/main/services/core/secureStorage.ts:104-125  loadPersistentEncryptionKey()
  src/main/services/core/secureStorage.ts:206-249  decrypt fail-closed（双失败不覆盖磁盘）
  src/main/services/core/secureStorage.ts:474-496  掩码 / safeStorage 可用性

静态门（步骤 3-6）:
  .github/workflows/swarm-ci.yml                smoke / full job（接入新门）
  .github/workflows/eval-harness-gate.yml       仅 typecheck（不动）
  .github/workflows/release.yml:119             release:security-scan
  scripts/prompt-stale-scan.ts                  既有静态门范例（参照其退出码/输出风格）
  package.json:lint                             eslint src --ext .ts,.tsx（孤立，待接入）
  package.json:release:security-scan            node scripts/release-security-scan.mjs（参照）
  新增 scripts/console-scan.mjs
  新增 scripts/a11y-scan.mjs
  新增 scripts/stale-dist-scan.mjs
```

---

## 3. 分步实现（每步小而可独立提交）

> 所有步骤独立 commit。提交顺序按依赖排列。每步先做实现，再做验证，验证不过不提交。

### 步骤 0 — 建立基线（无代码改动，仅留证据）

在改动前跑一次完整静态状态，作为回归对照基线。

```bash
cd /Users/linchen/Downloads/ai/code-agent
npm run typecheck 2>&1 | tee /tmp/gate-baseline-typecheck.log
npm run lint 2>&1 | tee /tmp/gate-baseline-lint.log      # 记录当前 lint 是红是绿（孤立脚本，可能本就报错）
npm run test:smoke 2>&1 | tee /tmp/gate-baseline-smoke.log
```

**验证 / 证据**: 三份 `/tmp/gate-baseline-*.log` 留存。若 lint 基线已是红的，步骤 6 接入前必须先修绿或先界定豁免范围，否则会卡死整条 CI。

---

### 步骤 1 — 权限 `reason` 枚举化（共享契约改动）

**实现**:
1. 在 `src/shared/contract/permission.ts` 新增枚举（不删除现有 `reason?: string`，新增并行字段，向后兼容）:
   ```ts
   export enum PermissionRequestReason {
     FileWriteOutsideWorkspace = 'file_write_outside_workspace',
     ShellHighRisk = 'shell_high_risk',
     NetworkEgress = 'network_egress',
     McpTool = 'mcp_tool',
     CredentialAccess = 'credential_access',
     Unknown = 'unknown',
   }
   ```
   接口加 `reasonCode?: PermissionRequestReason;`（保留 `reason?: string` 作为人类可读文案）。
2. `confirmationGate.ts:122 buildPreview()` 在生成 preview 时，按 `assessRiskLevel`（263）和工具类别同时填 `reasonCode` 与对应 `reason` 文案。提供一个 `reasonText(code): string` 映射函数集中文案。
3. `PermissionDialog/types.ts:58` 同步加 `reasonCode`；`PermissionCard.tsx:231-233` 渲染保持读 `reason`（文案），无需改 UI 行为——若 `reason` 为空再 fallback 到 `reasonText(reasonCode)`。

**验证计划**:
```bash
# a) 类型门
npm run typecheck 2>&1 | tee /tmp/gate-step1-typecheck.log     # 必须 0 错误

# b) targeted 单测——新增 tests/unit/agent/confirmationGate.reason.test.ts
#    断言: 每种工具类别 buildPreview 返回正确 reasonCode；reasonText 映射全覆盖（无 default 漏网）
npx vitest run tests/unit/agent/confirmationGate.reason.test.ts 2>&1 | tee /tmp/gate-step1-unit.log

# c) 既有权限相关单测不回归
npx vitest run tests/unit/tools/permissionClassifier.test.ts 2>&1 | tee /tmp/gate-step1-regress.log
```
- **共享契约对抗审查（强制）**: 该改动跨 main/renderer 双侧契约，提交前运行
  ```
  /multi-review src/shared/contract/permission.ts src/main/agent/confirmationGate.ts src/renderer/components/PermissionDialog/types.ts
  ```
  或 `codex-audit`。重点让审查方检查：枚举值是否穷尽、新旧字段是否真向后兼容（旧序列化的 request 无 reasonCode 时不崩）、双侧枚举是否同源（避免 renderer 复制一份导致漂移）。
- **权限弹窗 UI 视觉验证（强制）**: reason 渲染路径变了，必须走 `/e2e`。
  ```
  /e2e 触发一次需要权限确认的操作（如写工作区外文件），截图 PermissionCard，确认 reason 文案正常显示、Escape 仍触发 deny、记忆勾选仍可用
  ```
  留截图证据到 `docs/plans/evidence/2026-06-16-step1-permission-card.png`。

**提交**: `feat(permission): 枚举化权限 reason，保留文案向后兼容`

---

### 步骤 2 — 凭据存储回归测试（锁住 fail-closed 与掩码，不改实现）

**实现**: 仅新增测试，不动 `secureStorage.ts`。新增 `tests/unit/services/secureStorage.failclosed.test.ts`，覆盖三条不变量：
1. **fail-closed 不清盘**: 模拟新 key 与 legacy key 双双解密失败（206-249），断言磁盘 `secure-storage.json` 字节未被覆盖、返回空 Partial。
2. **掩码 round-trip**: setApiKey → getApiKey 取回原值；对外暴露/日志路径只见掩码（474-496）。
3. **safeStorage 不可用降级**: mock `safeStorage.isEncryptionAvailable()=false`，断言走 electron-store 加密路径、**绝不**落明文。

**验证计划**:
```bash
npm run typecheck 2>&1 | tee /tmp/gate-step2-typecheck.log
npx vitest run tests/unit/services/secureStorage.failclosed.test.ts 2>&1 | tee /tmp/gate-step2-unit.log   # 3 条全绿
```
- 此步是纯测试加固，无 UI、无契约改动，**不需要** /e2e 或 multi-review。
- 证据: `/tmp/gate-step2-unit.log` 显示 3 passed。

**提交**: `test(secure-storage): 锁定 fail-closed 与掩码 round-trip 回归`

---

### 步骤 3 — console-scan 静态门脚本

**实现**: 新增 `scripts/console-scan.mjs`，参照 `scripts/release-security-scan.mjs` 的退出码风格（命中→exit 1，附文件:行）。规则：
- 扫描 `src/**/*.{ts,tsx}`，命中裸 `console.log` / `console.debug`（允许 `console.error`/`console.warn`，或通过 allowlist 注释 `// console-scan-allow`）。
- 排除 `tests/**`、`scripts/**`、`*.test.*`。

**验证计划**:
```bash
node scripts/console-scan.mjs 2>&1 | tee /tmp/gate-step3-run.log
echo "exit=$?"                                  # 当前代码库下记录实际结果
# 自测：故意在临时文件加一行 console.log，确认脚本能命中并 exit 1，再删除
```
- 若全量扫描已有大量历史 `console.log`，**先以 warn 模式（exit 0 + 计数）落地**，把基线计数写进脚本，只对新增超基线 fail——避免一上来就红。把这个决策写进脚本注释。
- 证据: `/tmp/gate-step3-run.log` + 自测命中截图/日志。

**提交**: `chore(ci): 新增 console-scan 静态门脚本`

---

### 步骤 4 — a11y-scan 静态门脚本（轻量静态规则，不启浏览器）

**实现**: 新增 `scripts/a11y-scan.mjs`，对 `src/renderer/**/*.tsx` 做轻量静态规则（首版克制，避免误报洪水）：
- `<img>` 缺 `alt`。
- 纯图标 `<button>` 无 `aria-label` 且无文本子节点。
- `onClick` 挂在非交互元素（`<div>`/`<span>`）且无 `role` + `tabIndex`。
命中输出 `文件:行 + 规则`，退出码同 console-scan（首版可 warn-only + 基线计数）。

**验证计划**:
```bash
node scripts/a11y-scan.mjs 2>&1 | tee /tmp/gate-step4-run.log
echo "exit=$?"
# 自测：临时加一个无 alt 的 <img>，确认命中；删除
```
- 重点验证 **PermissionDialog 目录**（步骤 1 刚动过）零 a11y 命中：
  ```bash
  node scripts/a11y-scan.mjs src/renderer/components/PermissionDialog 2>&1 | tee /tmp/gate-step4-permission.log
  ```
- 证据: 两份 log。

**提交**: `chore(ci): 新增 a11y-scan 轻量静态门脚本`

---

### 步骤 5 — stale-dist-scan 静态门脚本

**实现**: 新增 `scripts/stale-dist-scan.mjs`，防止提交陈旧构建产物 / 源码改了但 dist 没重建：
- 比较 `dist/`（或 `dist-electron/`，按实际产物目录）最新 mtime 与 `src/**` 最新 mtime；若 src 比 dist 新 → 报 stale。
- 若仓库根本不提交 dist（gitignore），则改为校验：`git status` 中 dist 是否被意外 staged → 命中则 fail。先 `ls` 确认实际产物目录与 .gitignore 策略再定逻辑。

**验证计划**:
```bash
ls -d dist dist-electron build 2>/dev/null              # 先确认产物目录
node scripts/stale-dist-scan.mjs 2>&1 | tee /tmp/gate-step5-run.log
echo "exit=$?"
# 自测：touch 一个 src 文件，确认脚本判定 stale；npm run build 后确认恢复绿
```
- 证据: `/tmp/gate-step5-run.log` + 自测前后对照。

**提交**: `chore(ci): 新增 stale-dist-scan 静态门脚本`

---

### 步骤 6 — 接入 CI（lint + 三个新门挂上 swarm-ci.yml smoke job）

**实现**: 改 `.github/workflows/swarm-ci.yml` 的 smoke job，在 typecheck 后串入：
```yaml
- run: npm run lint
- run: node scripts/console-scan.mjs
- run: node scripts/a11y-scan.mjs
- run: node scripts/stale-dist-scan.mjs
```
- lint 接入前以步骤 0 基线为准：基线红则先修绿或加 `.eslintignore`/`--max-warnings` 界定；不要把红 lint 直接挂 CI 卡死所有 PR。
- 新门首版若是 warn-only（基线计数模式），CI 里仍调用以累计趋势，待基线清零后再翻成 hard-fail（后续迭代）。

**验证计划**:
```bash
# 本地按 CI 顺序串跑一遍，模拟 smoke job
npm run typecheck && npm run lint && node scripts/console-scan.mjs && node scripts/a11y-scan.mjs && node scripts/stale-dist-scan.mjs
echo "chain exit=$?" | tee /tmp/gate-step6-chain.log
```
- **CI 配置对抗审查（强制）**: workflow 改动影响所有 PR 闸门，提交前
  ```
  /multi-review .github/workflows/swarm-ci.yml
  ```
  重点：新增步骤是否会让现有 PR 集体变红、warn/fail 模式是否符合预期、是否拖慢 smoke job（要求仍 < 既有时长 + 30s）。
- 推送后观察首条 CI run 结果，截图留证。
- 证据: `/tmp/gate-step6-chain.log` + CI run 链接/截图。

**提交**: `ci(swarm): 接入 lint + console/a11y/stale-dist 静态门`

---

## 4. 验证手段汇总（按步骤）

| 步骤 | typecheck | targeted 测试 | /e2e 视觉 | 对抗审查 | 留证文件 |
|------|-----------|---------------|-----------|----------|----------|
| 0 基线 | ✅ | smoke | — | — | gate-baseline-*.log |
| 1 reason 枚举 | ✅ | confirmationGate.reason + permissionClassifier | ✅ PermissionCard | ✅ /multi-review（共享契约） | step1-*.log + 截图 |
| 2 凭据回归测试 | ✅ | secureStorage.failclosed | — | — | step2-unit.log |
| 3 console-scan | — | 脚本自测命中 | — | — | step3-run.log |
| 4 a11y-scan | — | 脚本自测 + PermissionDialog 专扫 | — | — | step4-*.log |
| 5 stale-dist-scan | — | 脚本自测前后对照 | — | — | step5-run.log |
| 6 CI 接入 | ✅ 链式 | 全链本地串跑 | — | ✅ /multi-review（workflow） | step6-chain.log + CI 截图 |

所有 `/tmp/gate-*.log` 与截图，归档到 `docs/plans/evidence/2026-06-16-*` 作为本次加固的验收证据包。

---

## 5. 风险与回滚

| 风险 | 等级 | 缓解 | 回滚 |
|------|------|------|------|
| reason 枚举改共享契约，旧序列化 request 无 reasonCode 导致 renderer 崩 | 中 | 字段设 optional + 保留旧 `reason` 文案字段，UI fallback；步骤 1 单测覆盖空 reasonCode 场景 | 单独 commit，`git revert` 即可，UI 仍读旧 `reason` |
| 双侧枚举各自复制导致漂移 | 中 | renderer `types.ts` 从 `shared/contract` import 枚举而非复制；multi-review 专门检查此项 | — |
| console/a11y/stale 三门一上来全红卡死所有 PR | 高 | 首版 warn-only + 基线计数，确认绿后再翻 hard-fail；步骤 0 先建基线 | workflow 改动单独 commit，revert 即解除 CI 卡点 |
| lint 接入时基线已红 | 中 | 步骤 0 先验基线；红则先修或 ignore 界定，不直接挂 | 从 workflow 移除 lint step |
| stale-dist 逻辑误判（产物目录/gitignore 策略不符预期） | 中 | 步骤 5 先 `ls` + 读 .gitignore 确认实际策略再写逻辑 | 脚本独立，移除 CI 调用即可 |
| 误改 secureStorage / confirmationGate 已稳态逻辑 | 高 | 范围边界 1.2 明确禁止；步骤 2 纯加测试不碰实现，步骤 1 只加字段不改风险评估 | 各步独立 commit，定位即 revert |
| /e2e 验证需真实触发权限弹窗，环境依赖（端口 3000 vite + 8180 后端） | 低 | 按 MEMORY 记录前后端解耦各自后台跑；Playwright 卡住清 mcp-chrome Singleton 锁 | — |

**整体回滚策略**: 每步独立 commit 且无跨步强依赖（步骤 3/4/5 互不依赖，6 依赖 3/4/5），任一步出问题 `git revert <step-commit>` 即可，不影响其余加固成果。
