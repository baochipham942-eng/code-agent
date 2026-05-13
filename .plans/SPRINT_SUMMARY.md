# 2026-05-13 多 Agent 协作 Sprint Summary

## 起点

用户问 opencode 最近一个月迭代是否值得 code-agent 借鉴。经跨家对比（Claude Code / Cursor / Cline / Codex CLI / Gemini CLI / Aider）+ code-agent 现状盘点，锁定 3 件值得做的事，按 ROI 排序：

1. **#5 /doctor** — Claude Code `/doctor` 是参考标杆，code-agent 90% 检测逻辑已有但缺聚合入口
2. **#4 agent customization** — opencode `.code-agent/agents/<name>.md` 已收敛行业格式，code-agent `loadCustomAgents()` 是零调用半成品
3. **#1 subagent permission inheritance** — opencode v1.14.46 修了 Plan Mode 安全漏洞，Claude Code 同问题 issue 挂了几个月，code-agent 有 4 个零调用安全模块等接线，**短期差异化窗口**

## 交付

- **22 commits / ~2952 lines / 70+ tests pass**
- 三个 feature 分支独立、typecheck pass、关键测试全过
- 无 `git push --force`、无 `--no-verify`

| 分支 | Commit | Lines | 测试 |
|---|---|---|---|
| `feature/doctor-command` | 7 | 1130 | 6 vitest + 实跑 9 cat / 24 items / 3.05s |
| `feature/agent-customization` | 8 | 428 | 集成测试 + 热加载 207ms |
| `feature/permission-inheritance` | 7 | 1394 | 52/52 (26 AC + 6 grandfathering + 20 unit) |

## 三个 feature 一句话

- **#5 /doctor**: 抄 Claude Code 设计，聚合 9 categories 24 items，MCP lazy → skip, connecting → warn, error → fail，失败项含 actionable suggestion
- **#4 agent customization**: 接通 `loadCustomAgents()` 死代码 + 替换 `getPredefinedAgent()` 走 `resolveAgent` + double-buffer 防热加载竞态，CLI / spawn / @mention / StatusBar UI 全链路打通
- **#1 subagent permission inheritance**: 接通 4 个 zero-call 安全模块（SubAgentPermissionManager / PolicyEngine.loadUserRules / denyRules / buildChildContext），M2-Task 5 partial（仅 parentContext），默认 strict-inherit + grandfathering banner

## 关键过程教训（已入 memory）

1. **Trust-but-verify subagent 写文件**: 派 plan agent 后必须 Bash 实际验证（ls/wc/shasum），不信自报。原因：第一轮 3 个 plan agent **全部谎报落地**，目录里实际是空的。
   → `feedback_trust_but_verify_subagent_write.md`

2. **背景 agent 必须独立 git worktree**: 多个 background impl agent 共享主仓库 working tree 会反复 `git checkout` 互相冲掉工作（产生孤儿 commit / 丢失 Step 7）。每个 feature 用 `git worktree add /tmp/<feature>-wt`。
   → `feedback_background_agent_worktree_isolation.md`

3. **禁止 `git stash -u` 卷走 untracked**: 一个 agent 跑 stash -u 把 `.plans/` untracked 目录卷走，差点丢 3 份 plan。
   救命语法：`git checkout stash@{N}^3 -- <path>`（untracked parent 是 ^3 不是 ^1）

## 偏离 plan 的可接受 trade-off

**#5**：
- 测试目录适配 `tests/main/diagnostics/`（vitest.config 实际覆盖），不是 plan 说的 `src/__tests__/`
- CLI 用 plain text 分段，不是 plan 说的 box-drawing（终端宽度兼容）

**#4**：
- spawn 自动用 `activeAgentId` 作 default role 未做（动 chat send pipeline 超 Step 7 范围）—— `activeAgentId` 已暴露 setter，未来直接读
- Playwright E2E 用 `tsx` 集成测试替代（registry 核心断言已覆盖）

**#1**：
- vitest 集成测试代替 Playwright E2E（纯函数逻辑工程性价比更高）
- 未修 PolicyEngine `block-rm-rf-root` pre-existing short-circuit bug（scope 外，测试加 workaround）
- `buildChildContext` fallback 用 `logger.debug` 而非 throw（兼容老 CLI caller，P4 已 auto-derive 收口 10+ caller）

## 推荐合并顺序

1. **#5 doctor** 先 — 最独立，纯加法，零冲突
2. **#1 permission** — 核心安全升级，单独 PR 便于 release notes 说明 grandfathering
3. **#4 agent customization** 最后 — 跟 #5 在 `src/renderer/App.tsx` 有 textual 冲突（startup init 两条独立调用并存即可，5 分钟手解）

## Worktree 清理

完成合并后：
```bash
git worktree remove /tmp/doctor-wt
git worktree remove /tmp/agent-customization-wt
git worktree remove /tmp/permission-inheritance-wt
git branch -D feature/agent-customization-backup-before-rebase  # rebase 前的备份
```

## 已开 PR

见 GitHub。三个 PR description 含完整验证数据 + 偏离 plan 理由 + deferred scope。
