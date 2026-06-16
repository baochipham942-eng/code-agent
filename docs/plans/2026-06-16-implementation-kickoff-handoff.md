# 实现 Kickoff 交接（2026-06-16）

> 给**新会话**用：读完这份就能直接开干，不用回溯前序讨论。来源是 maka + lody 两份竞品借鉴分析 → 多模型交叉评审 → 规划 workflow 产出。

## 背景一句话

对 maka-agent、lody.ai 两个竞品做了借鉴分析 + Codex/Gemini 交叉评审，收敛出 3 个要做的工作项。计划/ADR 已写好、分支已建、P0-1 架构决策已拍板。本次任务：**按下面顺序实现这 3 项**。成本已获用户批准（可做全部三项）。

## 质量与分工铁律（必须遵守）

- **用户看不懂代码、不做 code/diff review。代码质量是 Claude 全责**，靠：① 自审 diff（`git diff --stat` 逐文件，异常逐行看）② 分层验证（typecheck → targeted 测试 → UI 走 /e2e → 高风险改动走 /multi-review 或 codex-audit）③ **向用户汇报质量证据（说人话：测试通过数/覆盖范围/验证结论/截图），绝不贴 diff 让用户判断**。
- **用户只在设计决策（ADR）层拍板**。实现细节不要问用户。
- 详见 `CLAUDE.md` / `.claude/rules/testing.md` 的"提交纪律"（2026-06-16 已据此重写）。

## 实现顺序（有依赖，必须串行 1→2，3 可并行插队）

### 1. `feat/permission-credential-gates`（先做，风险最低）
- 计划：`docs/plans/2026-06-16-permission-credential-static-gates.md`（7 步，每步带可执行验证命令）
- 内容：权限弹窗 reason 枚举化 + 凭据 fail-closed/掩码回归测试锁定 + 新增 console/a11y/stale-dist 三个静态门接 CI
- 关键风险（计划里有缓解）：① 静态门首版 warn-only + 基线计数，确认绿后再翻 hard-fail ② reason 枚举改共享契约用 optional 字段 + 旧文案 fallback，renderer 从 shared 同源 import
- 证据归档：`docs/plans/evidence/`

### 2. `feat/event-ledger-spine`（紧接第 1 个，长在它清理好的权限链上）
- 决策：`docs/decisions/022-append-only-event-ledger-spine.md`（**已拍板 accepted**）
- **拍板结果：Q1 = C 混合（关系查询走 SQLite、事件流+大块产物外置）；Q2 = Y 最小切口先行；第一期试水场景 = 权限决策链**
- 本次只做**第一期**：把"事件总账"立起来，只接权限决策链一个场景（纯增量，不动现有任何表）。交付证据：界面/日志里能看到"每一次允许/拒绝都留下完整决策流水"。
- 为什么紧接第 1 个：第一期试水场景就是权限决策链，而第 1 个工作项刚把权限链清理/枚举化好，自然衔接、避免两条分支撞车。
- 第二/三/四期（崩溃恢复重放 / 迁移 Swarm+任务事件 / 一致性对账+老库迁移）等第一期跑出证据后再排。

### 3. `feat/g1-history-takeover`（独立，任意时机可并行）
- 计划：`docs/plans/2026-06-16-g1-history-takeover.md`（3 步）
- 内容：只读单向导入 `~/.claude`/`~/.codex` 历史并续聊。**明确不做双向回写（那是 G2，会被上游私有格式变更拖垮，不碰）**。
- 三步：Step1 transform 落库 → Step2 renderer Import 入口 → Step3 续聊传 `--resume`
- 脏活/风险：导入去重、来源解释只读提示、macOS 权限边界+脱敏、上游私有 JSONL 格式变更降级、`--resume` 与 `--no-session-persistence` 冲突兜底

## 起手式

```
checkout feat/permission-credential-gates
按 docs/plans/2026-06-16-permission-credential-static-gates.md 从 Step 0（基线）开始，每步先实现后验证，验证不过不进下一步。
```

## 关联文档
- 竞品分析：`docs/competitive/maka-agent-借鉴清单.md`、`docs/competitive/lody-borrow-list.md`（末尾都有"多模型评审修订"）
- 三方"只做 3 件事"的来由也在上面两份文件里
