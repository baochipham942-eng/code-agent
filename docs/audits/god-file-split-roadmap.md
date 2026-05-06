# God File Split Roadmap

> 状态: in-progress
> 日期: 2026-05-05
> 基线: origin/main @ 4e6cbbff
> 上游 audit: 2026-04-28 god-file audit（产出 19 文件白名单 + max-lines=1000 守门）

## 背景

`eslint.config.js` 在 2026-04-28 加了 `max-lines=1000` 硬限作为 god-file 守门，并把当时已超线的 19 个历史文件加进白名单 backlog。这份 roadmap 把 19 个文件按拆分难度排序、定义通用拆分 SOP、并通过 3 个 PoC 验证 SOP。

为什么是现在做：3 月刚拆完一批，1 个月内又有文件长回 >900 行；不立即把 backlog 啃下，下一轮重写大概率撞上同样的回归压力。

## 评分模型

每个文件按 **依赖耦合度（D）** + **测试覆盖（T）** 加权打分（1=最容易，5=最难）：

| 维度 | 权重 | 含义 |
|------|------|------|
| `imports` (该文件 import 的模块数) | 0.5 | 越多说明文件本身职责越发散 |
| `dependents` (有多少文件 import 该文件) | 1.5 | 越多说明对外 API 越广，拆分风险越高 |
| `exports` (导出符号数) | -0.3 | 越多反而暗示已经天然分组、可拆性强 |
| `existing tests` | -2.0 | 有测试 = 重构 safety net 已就位 |
| `单一职责度`（单一 god class? 还是混合？） | ±0.5 | 单一巨型 class 比混合 module 更容易做 facade-and-helpers 拆分 |

最终分数手工归到 1-5 整数。

## 19 文件难度排序

数据采集自 `git rev-parse origin/main = 4e6cbbff`：

| 排名 | 文件 | 行 | imports | deps | exports | tests | 难度 | 拆分思路 |
|------|------|---:|--------:|-----:|--------:|:------|:----:|---------|
| 1 | `src/main/scheduler/TaskDAG.ts` | 1098 | 4 | 5 | 1 | ✅ | **1** | 抽 graph 算法（拓扑/关键路径/校验）为 pure functions |
| 2 | `src/main/hooks/hookManager.ts` | 1020 | 13 | 6 | 5 | ✅ | **2** | 17 个 trigger 方法按事件类组成 strategy module |
| 3 | `src/main/evaluation/telemetryQueryService.ts` | 1277 | 10 | 4 | 1 | ✅ | **2** | 抽 600 行 transcript replay builder 为独立模块 |
| 4 | `src/main/tools/media/ppt/layouts.ts` | 1172 | 11 | 2 | 5 | ❌ | **2** | 数据驱动配置，按 layout family 拆为多文件 |
| 5 | `src/main/session/claudeSessionParser.ts` | 1121 | 6 | 0 | 15 | ❌ | **2** | deps=0 解耦，先补 fixture 测试再切 parser |
| 6 | `src/main/desktop/desktopActivityUnderstandingService.ts` | 1356 | 10 | 7 | 16 | ❌ | **3** | 16 export 天然分组，但需先补测试 |
| 7 | `src/main/agent/parallelAgentCoordinator.ts` | 1119 | 14 | 8 | 10 | ✅✅ | **3** | 高 deps 但测试齐，可切 lifecycle / scheduling 两块 |
| 8 | `src/cli/database.ts` | 1153 | 4 | 3 | 4 | ❌ | **3** | CLI 子命令 -> 每命令一文件 + 主 router |
| 9 | `src/main/services/desktop/backgroundCgEventSurface.ts` | 1241 | 11 | 2 | 9 | ❌ | **3** | 事件分发层，按事件类型切 |
| 10 | `src/main/services/desktop/desktopAudioCapture.ts` | 1168 | 9 | 3 | 3 | ❌ | **3** | native 接口 + 状态机，需先 mock 测 |
| 11 | `src/renderer/components/TaskPanel/Orchestration.tsx` | 1361 | 16 | 1 | 2 | ❌ | **3** | React 组件，按 sub-component 切 |
| 12 | `src/renderer/components/features/settings/sections/NativeDesktopSection.tsx` | 1136 | 4 | 3 | 1 | ❌ | **3** | React 组件，按 setting card 切 |
| 13 | `src/main/model/providerRegistry.ts` | 1319 | 2 | 5 | 2 | ✅ | **4** | 关键路径，每个 provider 注册逻辑可抽 |
| 14 | `src/main/agent/subagentExecutor.ts` | 1306 | 31 | 12 | 4 | ❌ | **4** | 高 import + 高 dep + 无测试 = 必须先补测试 |
| 15 | `src/main/services/core/databaseService.ts` | 587* | 15 | 24 | 4 | ❌ | **4** | 物理行少但有效行超线；deps=24 极广 |
| 16 | `src/main/model/providers/shared.ts` | 1296 | 7 | 27 | 23 | ✅ | **4** | deps=27 = 全 provider 共享，重构波及面最大 |
| 17 | `src/main/services/desktop/computerSurface.ts` | 1850 | 7 | 2 | 5 | ✅✅✅ | **5** | 体量最大，但有 3 个 test 兜底，分阶段切 |
| 18 | `src/main/services/infra/browserService.ts` | 1655 | 13 | 2 | 3 | ✅✅ | **5** | Puppeteer/CDP 状态机，必须保留 trace redaction 测试 |
| 19 | `src/main/tools/vision/computerUse.ts` | 1594 | 8 | 4 | 3 | ✅ | **5** | vision tool + native screenshot pipeline |

\* `databaseService.ts` 物理 587 行但 effective lines（去空白和注释）超 1000，仍在白名单。

### 难度分布

- **难度 1（PoC 1 候选）**: 1 个 — TaskDAG
- **难度 2（PoC 2/3 候选 + 后续轻量批）**: 4 个
- **难度 3（中量，需补测试）**: 7 个
- **难度 4（高耦合，需先解耦）**: 4 个
- **难度 5（重型，最后做）**: 3 个

## 通用拆分 SOP

每个文件按以下 7 步推进。**任何一步失败都不准跳过，回到上一步重做**。

### 1. Pre-flight (确认安全网)

```bash
# 1.1 列出现有测试
find tests -path "*<file_basename>*" -type f

# 1.2 跑现有测试基线，确认 pre-existing 全绿
npm test -- <test_path>

# 1.3 dependents 影响面采集
grep -rl --include="*.ts" --include="*.tsx" "from ['\"].*<basename>['\"]" src
```

如果 dependents > 5 或没有任何测试，**跳到第 2 步先补测试**，否则进 3。

### 2. 补测试（only if 现有覆盖 < 50%）

- 对外 API 的 happy path + 1 边界 case + 1 错误 case，三件套
- 用 vitest mock 隔离外部依赖（DB/network/native）
- 写完先跑红绿，再进重构

### 3. 切分边界识别

读源文件 head/middle/tail，找：

- `// ===` 章节注释（作者已经分组的强信号）
- 私有 helper 与 public API 的分界
- 纯函数（不依赖 `this` 状态）vs 状态方法
- 语义内聚的方法群（如 query / mutate / validate / serialize）

**优先抽纯函数**：风险最低，把 stateful god class 变成 facade + helpers 模式。

### 4. 拆分实施

- 新文件路径与原文件同目录（避免 import 重排扩散）
- 命名：`<originalBase><Feature>.ts`（如 `taskDagGraph.ts`、`hookTriggers.ts`）
- 主文件保留对外 API 不变（facade）；helpers 不导出给 src/ 之外
- **本步禁止改任何业务逻辑**，纯位移 + import 调整

### 5. 验证三件套

```bash
npm run typecheck                          # 必须 0 error
npm test -- <relevant_test_paths>          # 必须全绿
node -e "console.log(require('fs').readFileSync('<main_file>','utf8').split('\n').length)"  # 主文件 < 1000 行
```

### 6. 删除 ESLint 白名单

- 编辑 `eslint.config.js` 第 129-148 行白名单数组，删除该文件
- 跑 `npx eslint <file>` 确认 max-lines 不再报错

### 7. PR

- 标题：`refactor(godfile): split <file_basename> (~XXX -> ~YYY lines)`
- Body 必含：
  - **Before/After 行数对比表**（列每个新文件多少行）
  - **测试结果**（粘贴 `npm test` 输出）
  - **ESLint 白名单 diff**（证明该条已删）
  - **风险评估**（下游 dependents 列表 + 是否变更对外 API）

## PoC 选择

按 SOP 在 3 个最容易的文件上各做一遍，验证流程并固化模板：

| PoC | 文件 | 难度 | 切分理由 | 分支名 |
|-----|------|:----:|----------|--------|
| **1** | `TaskDAG.ts` | 1 | 测试齐 + 算法天然纯函数 + deps=5 适中 | `refactor/godfile-taskdag-split` |
| **2** | `telemetryQueryService.ts` | 2 | 测试齐 + 600 行 replay builder 是干净一刀 | `refactor/godfile-telemetry-split` |
| **3** | `hookManager.ts` | 2 | 测试齐 + 物理行最薄 + 17 trigger 天然分组 | `refactor/godfile-hookmanager-split` |

PoC 选型避开了"deps=0 但无测试"的 `claudeSessionParser`——理论上 deps=0 风险最低，但**重构无测试代码 = 在没有 safety net 的地方做手术**，把它放第二批做。

## 16 文件后续派活清单

PoC 跑通 SOP 后，剩余 16 个按以下批次派活：

### 批次 A — 难度 2/3 + 现有测试齐（先派）

| 文件 | 主要风险 | 派活子任务 |
|------|----------|------------|
| `parallelAgentCoordinator.ts` | deps=8 高 | 切 lifecycle / scheduling 两文件 |
| `providerRegistry.ts` | 关键路径 | 每个 provider register 抽独立 module |
| `computerSurface.ts` | 1850 行最长，但 3 个 test 兜底 | 分 2 阶段切：先抽 telemetry storage（已有专测），再切 reliability 部分 |
| `browserService.ts` | CDP 状态机 | 抽 trace redaction + profile resolver 两块（已有专测） |
| `computerUse.ts` | vision pipeline | 抽 foreground warning 模块 |

### 批次 B — 难度 2/3 + 需先补测试

| 文件 | 子任务 1（补测试） | 子任务 2（拆分） |
|------|-------------------|-----------------|
| `ppt/layouts.ts` | layout family snapshot 测试 | 按 family 拆为子目录 |
| `claudeSessionParser.ts` | fixture-driven parser 测试 | 按消息类型切 parser |
| `desktopActivityUnderstandingService.ts` | 16 export 主链路 happy path 测试 | 按 export group 切 |
| `cli/database.ts` | CLI 子命令 e2e 测试 | 每命令一文件 + 主 router |
| `backgroundCgEventSurface.ts` | 事件回放 fixture | 按事件类型切 |
| `desktopAudioCapture.ts` | native capture mock 测试 | 状态机 + 编解码切两块 |
| `Orchestration.tsx` | RTL 渲染快照 | 按 sub-component 切 |
| `NativeDesktopSection.tsx` | RTL 渲染快照 | 按 setting card 切 |

### 批次 C — 难度 4/5（最后做）

| 文件 | 切前必须先做 | 切分方案 |
|------|--------------|----------|
| `subagentExecutor.ts` | 补完整测试套（imports=31 极易破） | 按 lifecycle / IO / metrics 切三块 |
| `databaseService.ts` | 补 dependents 集成测试（deps=24） | repository 层抽 + 连接管理抽 |
| `providers/shared.ts` | 评估 API 稳定性（deps=27） | 按 provider type 抽 base class hierarchy |

## 派活模板

派给子 Agent 时，每个文件用如下 prompt 模板（避免 scope drift）：

```
Worktree base: <分支名 from PoC 表>
Worktree path: ~/Downloads/ai/code-agent-godfile-<basename>
Symlink node_modules: ln -s ~/Downloads/ai/code-agent/node_modules node_modules

scope（不准超出）: 只动 <file path> 一个文件 + 其新拆出的 helper 文件
                + eslint.config.js 白名单删除
                + 必要的测试新增（不改既有测试 assertions）

DoD:
1. <file> < 1000 行
2. npm run typecheck 0 error
3. npm test -- <related_test_paths> 全绿
4. eslint.config.js 白名单已删该文件
5. PR body 含 before/after 行数表 + 测试输出 + 风险评估

护栏:
- 禁改业务逻辑，纯位移 + import 调整
- 禁改对外 API（facade 必须保持原 export shape）
- 禁动除目标文件外的源文件（除非必要的 import 路径修正）
- 禁删任何现有测试
```

## 进度追踪

| 阶段 | 状态 | 完成日期 | PR |
|------|:----:|---------|---|
| Roadmap + SOP | ✅ | 2026-05-05 | (this doc) |
| PoC 1 — TaskDAG | ⏳ | - | - |
| PoC 2 — telemetryQueryService | ⏳ | - | - |
| PoC 3 — hookManager | ⏳ | - | - |
| 批次 A | 🔒 | 待 PoC 验证 SOP | - |
| 批次 B | 🔒 | 待 PoC 验证 SOP | - |
| 批次 C | 🔒 | 批次 A/B 后 | - |
