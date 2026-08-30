# Ship Note — feat/policy-check（neo policy check — exec-policy 离线校验，CI pre-gate）

> 日期：2026-08-31 · 分支：feat/policy-check（headless orchestration PR5/5，基点 origin/main e5a8abd55）

## What / Why

新增 `neo policy` 命令组，给 exec-policy 规则集（`.code-agent/exec-policy.json`）一个**完全离线**的校验器，可直接挂在 CI 里当 pre-gate：无模型调用、无网络、无副作用、不改写 policy 文件。

- `neo policy check [--file <path>] [--expect "cmd=decision"...] [--json]` — 三层校验：
  1. **SYNTAX**：合法 JSON + schema（`version: 1`、`rules` 数组、PrefixRule 形态、decision ∈ allow|prompt|forbidden、pattern 非空且无空 token、source ∈ user|builtin、createdAt 有限数字；examples 条目形态）。
  2. **CONFLICTS**：见下方分类。
  3. **EXAMPLES**：示例命令逐条过 matcher，断言实际决策 = 期望决策，逐条报告 `✓/✗ 命令 → 实际（期望 X）`。
- `neo policy explain <command> [--file <path>] [--json]` — 解释一条命令命中了哪条规则及原因（最长前缀、规则来源），未命中则说明走常规权限流程。

文件定位与运行时 `ExecPolicyStore` 完全一致：`--file` 优先 → 项目级 `<project>/.code-agent/exec-policy.json`（`-p/--project`，默认 cwd）→ 用户级 `<dataDir>/exec-policy.json`。

## 冲突分类（match() 是最长前缀匹配，shadowing 语义以此为准）

- `duplicate-pattern`：pattern 完全相同。同长匹配先出现者胜出、后者恒不可达——decision 相同 → warning（冗余）；不同 → error（文件意图有歧义）。
- `shadow-escalation`：短 pattern 是长 pattern 的严格前缀，**短规则为 forbidden 而长规则更宽松**（allow/prompt）。最长前缀下长规则在其子树内恒胜出，forbidden 硬边界被悄悄穿透 → error。刻意不罚「宽规则 prompt + 窄规则 allow」——prompt 本就是默认态，learnFromApproval 的设计用法就是显式放行子树，罚它会把所有真实 policy 文件全部打红。
- `banned-prefix-allow`：pattern[0] 命中 `BANNED_PREFIXES`（python/node/sudo/bash/powershell…）且 decision 为 allow。learnFromApproval 永远拒学这类 prefix，手写 allow 会绕过防护 → error。banned prefix 上的 prompt/forbidden 不算违规。

## Examples 约定（刻意保持 stupidly simple）

两处来源，同一形态 `{ command, expect }`，合并后逐条断言：

1. **policy 文件内顶层 `examples` 数组**（推荐 CI 用法：一个文件自描述）。`ExecPolicyStore.load()` 只读 `version`/`rules`，多余字段天然忽略，零运行时影响。
2. **CLI `--expect "git status=allow"`**（可重复，commander collect）。

未命中任何规则的命令实际决策记为 `no-match`，不等于任何期望值（会 FAIL 并给出 diff）。

## 退出码

- `0` = 全部通过（含**无 policy 文件**的默认查找：报 no-policy 后视为通过——CI 直接跑 `neo policy check` 即可，repo 未配 policy 不会误红；要严格就用 `--file` 钉路径，缺失即失败）。
- `1` = 任一 error 级问题或任一示例断言失败（warning 不影响退出码）。
- `2` = 用法错误（commander 标准，如 `--expect` 格式错）。

## 实现

- `src/host/security/execPolicy.ts`：导出 `BANNED_PREFIXES`；把匹配核心抽成纯函数 `tokenizePolicyCommand` / `matchPolicyRule`，`ExecPolicyStore.match`/`learnFromApproval` 改为委托——校验器与运行时共享同一实现，语义不分叉。既有 23 条 execPolicy 测试未动、全绿。
- `src/host/security/execPolicyCheck.ts`（新增，纯函数、无 IO/日志/副作用）：`parseExecPolicy`（收集式报错不 throw）、`findPolicyConflicts`、`checkPolicyExamples`、`explainPolicyCommand`。
- `src/cli/commands/policy.ts`（新增）：check / explain 子命令。text 报告为单行批量 `console.log`（console-scan 棘轮 318 内；console.error 允许）。
- `src/cli/index.ts`：**metadataOnly 轻量路由**——`policy` 加入 `neo --help` 桩列表；`requestedCommand === 'policy'` 走独立分支只动态 import `./commands/policy`，不触发 chat/run/serve 等会在 import 时初始化可写目录的模块批量加载。

## 验证证据

### 静态门

- `npm run typecheck` 0 错；`npm run build:cli` 成功（dist/cli/index.cjs）；改动文件 eslint 0 error 0 warning。
- `npm run gates:local`：**38/38 全绿**（终版在 rebase 后空闲机器上复跑确认；一次并发负载下的 main-chain vitest 子集红为机器负载 flake，空闲复跑全绿）。过程中命中两道棘轮并已修复：console-scan（policy.ts 裸 console.log 22 处使总数 330 > 318 → 改批量单行输出收敛到 8 处，总数 316）；knip dead-export（`PolicyIssueCode` 仅模块内使用 → 去掉 export）。

### 单测

- `tests/security/execPolicyCheck.test.ts`（+17）：语法（合法/坏 JSON/错 version/坏 decision/空 pattern/坏 source/坏 createdAt/部分条目损坏/examples 形态）、冲突（duplicate warning vs error、shadow-escalation 双向、allow-under-prompt 不罚、banned-prefix-allow 与 prompt/forbidden 豁免、与 match() 语义对拍）、examples 逐条 diff、explain（命中/未命中/canonicalize 失败）、tokenize 与 store 一致。
- `tests/unit/cli/policyCommand.test.ts`（+13）：exit 0 全通过 / exit 1 坏 JSON / shadow-escalation 报告 / 示例逐条 diff / --json 结构 / 默认项目级解析（-p）/ 用户级 fallback / 无文件 exit 0 / 显式 --file 缺失 exit 1 / explain 命中与未命中 / explain 拒绝坏文件 / index.ts 轻量路由静态断言（桩列表含 policy、policy 分支不 import chat）。
- 全量 `npx vitest run`：**分支 22335 passed / 2606 files（0 失败） vs 基线 origin/main 22305 passed / 2604 files（0 失败）**——+30 全是本 PR 新增（17 + 13），无回归。

### E2E（新构建 dist/cli/index.cjs，sandbox /tmp/neo-e2e-policycheck，无模型）

- (a) 合法 policy + 3 条示例全中 → exit 0，逐条 ✓。
- (b) JSON 语法损坏 → exit 1，`[invalid-json]` 带行列号。
- (c) shadow-escalation + duplicate-pattern + banned-prefix-allow 混合 → exit 1，三类冲突逐条列出。
- (d) 示例实际 ≠ 期望 → exit 1，`✗ "git status" → prompt（期望 allow）` 逐条 diff。
- (e) `policy explain "git push origin main"` → 命中规则 `["git","push"]`、决策、最长前缀原因；无规则命令 → no-match + 走常规权限流程。
- (f) 无 policy 文件 → exit 0，明确提示已检查路径与 CI 钉路径建议；显式 `--file` 缺失 → exit 1。
- metadataOnly 轻路径：`neo --help` 列出 policy；`policy check` 在全新 `$HOME` 沙箱下运行后 home 目录**零文件创建**（不触碰可写目录），单次冷启动 ~0.7s。
