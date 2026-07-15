# Local Workspace

This workspace inherits the always-on collaboration rules from `/Users/linchen/AGENTS.md`.

## Codex Memory Bootstrap

- For every new Codex session rooted here, load memory from `/Users/linchen/.codex/memories/`, not from any Claude memory directory
- Read `/Users/linchen/.codex/memories/MEMORY.md` first
- At session start, expand `/Users/linchen/.codex/memories/soul.md` once; in later turns of the same live conversation, rely on existing context instead of re-reading it
- Re-expand `/Users/linchen/.codex/memories/soul.md` after context compaction, session resume, or any sign that identity/tone constraints have drifted
- Read `/Users/linchen/.codex/memories/daily/<today>.md` at session start; if today's daily is missing, read the most recent file under `/Users/linchen/.codex/memories/daily/`
- Do not bulk-expand indexed `feedback_*.md`; use `/Users/linchen/.codex/memories/MEMORY.md` keywords plus the current task to open only directly relevant feedback files
- If memory is still insufficient, say `我记不清，让我去翻一下。` and then inspect the relevant Codex memory files before answering
- Keep Codex memory separate from `~/.claude/projects/-Users-linchen/memory/...` unless the user explicitly asks for a Claude-side comparison
- Load project-specific repo context only after the Codex memory bootstrap

## 多 Agent 协作纪律（四步，硬规则）

多个 CLI Agent / 会话并行动同一仓库时（本仓已发生 3+ 次同款事故：过期本地 main、旧 bundle 假验证、验收对象不是最终合入产物），任何 agent 认领任务必须走：

1. **认领前 fetch + ff-only**：开工先 `git fetch origin`，工作分支基于 `origin/main` 新建；更新本地 main 只允许 `git merge --ff-only origin/main`，拒绝 ff 说明本地 main 已脏，以 `origin/main` 为准另起分支，不要 forward-fix 本地指针。
2. **活跃中 30min re-fetch**：任务超过 30 分钟或跨会话续做时重新 `git fetch origin` 并核对基点是否落后；落后先 rebase/重开分支再继续，不允许在已知过期的基点上继续堆提交。
3. **push 后播报 HEAD sha**：任何 push（分支或 main）完成后，在交接/汇报里写明 `git rev-parse HEAD` 的 sha，接力方以 sha 对齐，不以分支名对齐（分支名会被移动）。
4. **验收一律 origin/main 新鲜构建**：验收/dogfood 的对象必须是 `origin/main`（或目标分支）拉下来的新鲜构建，逐层确认构建产物指纹（bundle 文件名 / 版本号）与源码一致；禁止拿本地残留构建、renderer 热更新缓存、旧安装包做验证结论。

## 落地变更统一走 `ship`（机器级命令，已在 PATH）

推分支、开 PR、合并 main 一律用 `ship`，不要手工 `git push origin main` 或 `gh pr merge`：

```bash
ship pr --title "..."     # 在 feature 分支的干净工作树里：推分支 + 开 PR
ship merge <pr#>          # 串行合并队列：等 GitHub CI 全绿 + 不落后 main 才 squash 合并
ship cleanup --branch <B> --worktree <PATH>   # 合并后清理（未合进 main 会拒删）
```

- 合并策略：无冲突 + CI 全绿 + 不落后 main（落后会自动 update-branch 重验，最多 3 轮）。其他进行中的分支不阻塞你。
- 一切失败 fail-closed：ship 报错就停下如实汇报，禁止绕过（禁手工 merge、禁 `--force` 类替代）。
- 熔断开关 `~/.ship/disabled` 是用户的紧急刹车，存在时自动化全停，不要删除。
- 用法详情：`ship --help`。

