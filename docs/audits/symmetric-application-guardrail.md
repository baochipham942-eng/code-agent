# 对称性应用 Guardrail 设计

**日期**: 2026-05-05
**Owner**: 产品负责人 / Claude (Opus 4.7)
**状态**: PoC 已落地（provider 列表）；其余 4 个模式待 follow-up

## 背景

最近 3 周（≈ 2026-04-14 至 2026-05-05）的 fix commit 中，约 20% 属于"改 A 没扫 B"——即对称性应用（symmetric application）漂移。代码改动在概念上对称的两个或多个位置应该同时改，但实际只改了其中一处，导致行为不一致或静默失败。

### 历史强证据（5 条）

| Commit | 漏改 | 应改 | 模式 |
|---|---|---|---|
| `316184b4` | `QUICK_SWITCH_PROVIDERS` (UI) | catalog 加了 xiaomi 但 picker 没加；4 个 mimo-* 模型选不中 | Provider 列表 |
| `65a20b5f` | `SUPPORTED_PROVIDERS` (常量过滤) | catalog/QUICK_SWITCH 已收录 local，常量黑掉 | Provider 列表 |
| `4c8b5d7d` | `CLIConfigService` 读源 | main `ConfigService` 写 config.json，CLI 读 settings.json | Settings 字段 |
| `dc00e787` | 主聊天 ModelSwitcher | 设置面板改了主聊天没改 | UI 面板对称 |
| `fedf09da` | turn_snapshots 同步 | DB schema 加 column，repository 方法没补 | DB schema vs repo |

这些都不是逻辑 bug——是位置 bug。需要 guardrail。

---

## 5 个常见 symmetric application 模式

### 1. Provider 注册（PoC 已落地）

**锚点**：
- `src/shared/model-catalog.json` `.providers[].id` —— 元数据真相源
- `src/shared/constants/models.ts` `SUPPORTED_PROVIDERS` —— catalog 过滤白名单
- `src/renderer/components/StatusBar/ModelSwitcher.tsx` `QUICK_SWITCH_PROVIDERS` —— 快切 UI 子集
- `src/shared/constants/providers.ts` `getProviderDisplayName` —— i18n 显示名

**不变量**：
- HARD: `SUPPORTED ⊆ catalog` —— 否则 `PROVIDER_MODELS.filter` 得空，ghost provider
- HARD: `QUICK_SWITCH ⊆ SUPPORTED` —— 否则 `PROVIDER_MODELS_MAP[id] = undefined`，UI 静默 fallback `[]`
- WARN: `catalog \ SUPPORTED ≠ ∅` —— catalog 多出来的 provider 可能是漏加 SUPPORTED

**抓不到的反向**：`SUPPORTED \ QUICK_SWITCH ≠ ∅` 是 by-design 子集关系（QUICK_SWITCH 是手选热门 provider），无法用集合不变量约束。后续若要硬约束 `316184b4`-class bug，需要在 catalog 加 `featuredInQuickSwitch: true` 字段。

**检测规则**（已实现）：
```bash
# catalog
jq -r '.providers[].id' src/shared/model-catalog.json | sort -u

# SUPPORTED_PROVIDERS（awk 抓 marker 块 + grep 单引号字符串）
awk '/SUPPORTED_PROVIDERS = new Set/,/\]/' src/shared/constants/models.ts \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u

# QUICK_SWITCH_PROVIDERS（同上）
awk '/QUICK_SWITCH_PROVIDERS = /,/\]/' \
  src/renderer/components/StatusBar/ModelSwitcher.tsx \
  | grep -oE "'[^']+'" | tr -d "'" | sort -u

# 三集合 comm -23 求差集，HARD 违规 exit 1
```

---

### 2. Settings 字段对称

**锚点**：
- `src/shared/contract/settings.ts` —— TypeScript 类型契约
- `src/main/services/core/configService.ts` —— Tauri main 持久化（写 `config.json`）
- `src/cli/config.ts` (`CLIConfigService`) —— webServer/CLI 持久化（写 `settings.json`）
- `src/renderer/components/features/settings/tabs/*` —— 面板 UI
- `src/renderer/i18n/{zh,en}.ts` —— 显示名

**不变量**：
- HARD: 字段名出现在 contract 类型必须出现在 `ConfigService` getter/setter 必须出现在 `CLIConfigService`（除非显式标记 main-only）
- HARD: `ConfigService` 与 `CLIConfigService` 读源同源（`4c8b5d7d` 修复后约定都读 `config.json`，CLI 兼容回落 `settings.json`）

**检测规则**（待实现）：
```bash
# 提取 contract 字段名
grep -oE "^\s*([a-z][a-zA-Z]+):\s" src/shared/contract/settings.ts \
  | tr -d ':' | tr -d ' ' | sort -u

# 在 main 和 CLI ConfigService 各 grep 字段，比较 set
```

AST 路线（更鲁棒）：用 `ts-morph` 解析 contract interface 字段，对 `ConfigService.get*/set*` 方法名做集合比较。

---

### 3. Tool 注册

**锚点**：
- `src/main/agent/tools/<toolName>.ts` —— 工具实现
- `src/main/agent/tools/registry.ts`（或 toolDefinitions） —— 注册表
- `src/main/security/policyFile.ts` —— 权限 / policy
- 工具 schema export（给 LLM 看的）
- `src/renderer/i18n/{zh,en}.ts` —— UI label
- 测试 fixture

**不变量**：
- HARD: 实现文件中 `export const <Tool>` 必须在 registry 出现
- HARD: registry 中每个 tool 必须在 policy 文件有授权条目（默认 `deny`）
- WARN: i18n 缺 label —— UI 显示 raw tool name

**检测规则**（待实现）：
```bash
# 实现端
grep -lrE "^export const \w+Tool" src/main/agent/tools/

# registry 端
grep -oE "\b\w+Tool\b" src/main/agent/tools/registry.ts | sort -u

# diff
```

---

### 4. DB schema vs repository

**锚点**：
- `supabase/migrations/<ts>_<name>.sql` —— 迁移
- `src/main/db/schema.ts` —— TS 类型映射
- `src/main/services/core/repositories/*.ts` —— DAO
- 测试 fixture

**不变量**：
- HARD: 迁移中新增 column 必须在 schema.ts 类型出现
- HARD: schema.ts 中 column 必须在对应 repository 方法的 SELECT/INSERT/UPDATE 子句出现（除非该 column 完全只读 / 默认值）

**检测规则**（待实现）：
```bash
# 提取迁移最后 N 条 ALTER TABLE 加的 column
grep -hE "^\s*ALTER TABLE.*ADD COLUMN" supabase/migrations/ | ...

# 对比 schema.ts 和 repository.ts
```

AST 路线更可靠（grep SQL 不健壮）。可考虑用 `pg-query-emscripten` 或 `pgsql-ast-parser`。

---

### 5. i18n key parity

**锚点**：
- `src/renderer/i18n/zh.ts`
- `src/renderer/i18n/en.ts`
- 任何后续新增 locale

**不变量**：
- HARD: `keys(zh) === keys(en)` —— 任何 locale 缺 key 即 fail

**检测规则**（待实现）：
用 `ts-morph` 解析两个文件的 default export 对象，递归 flatten key 路径，对比 set 差集。grep 方式因嵌套对象不可靠，必须 AST。

---

## 实现选型

| 方案 | 反馈速度 | 可绕过 | 跨文件能力 | 维护成本 | 推荐 |
|------|---------|--------|-----------|---------|------|
| pre-commit (husky) | 极快（本地<1s） | `--no-verify` 可绕 | ✅ shell/node 自由 | 低，复用 `check-hardcoded-models.sh` 风格 | ✅ |
| GitHub Actions | 慢（push 后） | 不可绕 | ✅ 完全自由 | 低，YAML 一份 | ✅ |
| ESLint custom rule | 极快（IDE 内） | 可禁/忽略 | ❌ per-file visitor，跨文件 set diff 别扭 | 高，要写 plugin | ❌ |

**ESLint 是错的工具**——symmetric application 本质是 cross-file set 差集，ESLint 强项在单文件 AST。强行做需要 project-wide visitor 缓存 + lint-staged 全量传文件，破坏增量 lint 假设。

**推荐双层**：
- **pre-commit (husky)**：cheap 本地反馈，写错立刻拦下，避免 CI 等几分钟
- **GitHub Actions**：unforgeable 闸门，PR merge gate，`--no-verify` 也跳不过去

两层互补：本地宽松 / 远端严格。

---

## PoC 落地（本 PR）

### 文件清单

| 文件 | 说明 |
|------|------|
| `scripts/check-provider-symmetry.sh` | 三锚点 set diff，HARD/WARN 分级，`--quiet` 模式 |
| `.husky/pre-commit` | 加一行 `bash scripts/check-provider-symmetry.sh --quiet` |
| `.github/workflows/provider-symmetry.yml` | paths-filter 触发，跑 strict 模式 |
| `src/shared/constants/models.ts` | 修 baseline 漂移：SUPPORTED 加 `volcengine` + `grok` |

### PoC 上线即抓到 2 个 latent bug

跑 `bash scripts/check-provider-symmetry.sh` 第一次输出（修 baseline 前）：

```
✗ HARD violation: QUICK_SWITCH_PROVIDERS 含 SUPPORTED 没有的 provider
    - volcengine
⚠ WARN: catalog 中有 provider 未暴露在 SUPPORTED_PROVIDERS
    - grok
    - volcengine
```

- `volcengine`（火山引擎，4 model）：在 QUICK_SWITCH 但 SUPPORTED 漏加，`PROVIDER_MODELS_MAP['volcengine'] = undefined`，picker 静默 fallback `[]`，用户在快切里点不到任何豆包模型。
- `grok`（xAI，2 model）：catalog 元数据齐备但完全未暴露，UI 全链路看不到。

两条都属 `65a20b5f`-class bug，本 PR 一起修了。

### 回归验证

```
状态                            exit  catalog/SUPPORTED/QUICK_SWITCH
原始 main                       1     14/12/8  (volcengine HARD)
修 baseline 后                  0     14/14/8
模拟 65a20b5f：删 'local'       1     14/13/8  (local HARD)
revert 后                       0     14/14/8
```

闸门可启动 / 可回退 / 可抓真实漂移，三件套齐备。

---

## 局限

1. **抓不到 `316184b4`-class**：QUICK_SWITCH ⊆ SUPPORTED 是 by-design 子集（仅热门 provider 进快切），没法形式化"应在快切但漏加"。后续若要硬约束，在 catalog 加 `featuredInQuickSwitch: bool` 字段，脚本加 `featured ⊆ QUICK_SWITCH` 检查。
2. **文本解析脆性**：`awk + grep + sed` 对锚点文件结构变化敏感。如果有人把 `SUPPORTED_PROVIDERS` 改成 `SUPPORTED_PROVIDERS = Array.from(new Set([...]))` 之类的写法，提取器可能 silently 抓空。脚本对"任一锚点抓出空集"做了 hard error（exit 2），但完美方案是迁到 ts-morph AST。
3. **i18n 锚点未覆盖**：`getProviderDisplayName` 是函数实现，不是简单 const 数组，提取需要 AST。当前 PoC 不校验 i18n 完整性。

## Rollout 计划

按 fix commit 频次排：

| # | 模式 | 难度 | 预期 commit 拦截率 |
|---|------|------|-------------------|
| 1 | Provider 注册 | 低（已完成） | 2/5 历史 commit |
| 2 | Settings 字段（CLIConfigService 同源） | 中（需 ts-morph） | 1/5 |
| 3 | DB schema vs repository | 中（SQL parser） | 1/5 |
| 4 | Tool 注册 | 低（grep + registry） | — |
| 5 | i18n key parity | 中（嵌套对象 AST） | — |

每个模式遵循同样模板：
- `scripts/check-<pattern>-symmetry.sh`（或 `.ts` 若需要 AST）
- `.husky/pre-commit` 加一行 `--quiet`
- `.github/workflows/<pattern>-symmetry.yml` paths-filter

预算：每个 follow-up ≤ 0.5 PR-day。

## 历史参考

- `scripts/check-hardcoded-models.sh` —— 同一脚本风格的前身（检测废弃模型名 + 禁止 fallback）。本 PoC 完全复刻其 staged/`--all` 双模式 + 颜色输出风格，无新依赖。
