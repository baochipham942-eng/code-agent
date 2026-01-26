# Code Agent Git 分支开发流程

> 从 CLAUDE.md 提取的 Git 工作流文档

## 核心原则

1. **main 分支是唯一真相来源** - 所有发布都基于 main
2. **功能开发在 worktree 分支** - Claude Code 会话自动创建 worktree
3. **完成即合并** - 功能完成后必须立即合并到 main
4. **合并后再打包** - 打包前确认代码已在 main 分支

---

## 分支生命周期

```
┌─────────────────────────────────────────────────────────────────┐
│                        Git 分支工作流                            │
├─────────────────────────────────────────────────────────────────┤
│                                                                 │
│  1. 开始开发                                                     │
│     ┌──────────────┐                                            │
│     │ Claude Code  │ ──创建──> ~/.claude-worktrees/xxx/         │
│     │   会话开始    │          (自动创建 worktree 分支)           │
│     └──────────────┘                                            │
│            │                                                    │
│            ▼                                                    │
│  2. 功能开发                                                     │
│     ┌──────────────┐                                            │
│     │  在 worktree │ ──提交──> feature-branch                   │
│     │   中开发代码  │          (多次 commit)                     │
│     └──────────────┘                                            │
│            │                                                    │
│            ▼                                                    │
│  3. 功能完成 ⚠️ 关键步骤                                         │
│     ┌──────────────┐      ┌──────────────┐                      │
│     │  切换到主仓库 │ ──→  │ 合并到 main  │                      │
│     │ cd ~/...     │      │ git merge    │                      │
│     │ /code-agent  │      │ feature-xxx  │                      │
│     └──────────────┘      └──────────────┘                      │
│            │                                                    │
│            ▼                                                    │
│  4. 验证 & 打包                                                  │
│     ┌──────────────┐      ┌──────────────┐                      │
│     │ typecheck &  │ ──→  │ npm run      │ ──→ 发布             │
│     │ build        │      │ dist:mac     │                      │
│     └──────────────┘      └──────────────┘                      │
│                                                                 │
└─────────────────────────────────────────────────────────────────┘
```

---

## 完整工作流命令

```bash
# ========== 1. 功能开发完成后 ==========
# 在 worktree 中确认所有改动已提交
git status
git add . && git commit -m "feat: xxx"

# ========== 2. 切换到主仓库合并 ==========
cd /Users/linchen/Downloads/ai/code-agent

# 查看当前分支（应该是 main）
git branch

# 查看未合并的分支
git branch --no-merged main

# 合并功能分支
git merge pensive-robinson -m "Merge branch 'pensive-robinson' - 功能描述"

# ========== 3. 验证合并结果 ==========
npm run typecheck
npm run build

# ========== 4. 更新版本号（如果需要发布）==========
# 编辑 package.json 递增版本号
# 编辑 vercel-api/api/update.ts 更新版本号

# ========== 5. 提交版本更新 ==========
git add package.json vercel-api/api/update.ts
git commit -m "chore: bump version to x.x.x"
git push

# ========== 6. 打包发布 ==========
npm run dist:mac

# ========== 7. （可选）清理已合并的分支 ==========
git branch -d pensive-robinson
```

---

## 常见错误及预防

| 错误场景 | 后果 | 预防措施 |
|---------|------|----------|
| 在 worktree 中打包 | 产物位置不对，用户更新失败 | 打包前 `pwd` 确认目录 |
| 忘记合并到 main | 新功能不生效，用户看不到 | 完成功能后立即合并 |
| 合并后忘记 push | 云端版本检查不到新版本 | 合并后立即 push |
| 多分支并行开发不合并 | 代码分散，功能丢失 | 每个功能完成就合并 |

---

## 检查未合并分支

```bash
# 在主仓库执行
cd /Users/linchen/Downloads/ai/code-agent

# 列出所有未合并到 main 的分支（按提交数排序）
git branch --no-merged main | while read branch; do
  count=$(git log main..$branch --oneline 2>/dev/null | wc -l)
  if [ "$count" -gt 0 ]; then
    echo "$branch: $count commits"
  fi
done | sort -t: -k2 -rn

# 查看特定分支的提交内容
git log main..branch-name --oneline
```

---

## Worktree 说明

Claude Code 使用 git worktree 机制：
- **位置**: `~/.claude-worktrees/code-agent/<session-name>/`
- **特点**: 独立工作目录，共享 .git 仓库
- **风险**: worktree 归档后，**未提交的改动会丢失**
- **最佳实践**: 频繁提交，完成后立即合并到 main

---

## 发布清单

```
□ 功能开发完成，所有改动已 commit
□ 切换到主仓库: cd /Users/linchen/Downloads/ai/code-agent
□ 合并功能分支: git merge <branch-name>
□ npm run typecheck 通过
□ npm run build 通过
□ package.json 版本号已递增
□ vercel-api/api/update.ts 已更新
□ git push 推送到远程
□ npm run dist:mac 打包
□ 同步 .env 文件: cp .env "/Applications/Code Agent.app/Contents/Resources/.env"
□ 验证新版本可正常启动
```

---

## ⚠️ 打包后必做

**同步 .env 文件**（打包不会自动包含）：

```bash
cp /Users/linchen/Downloads/ai/code-agent/.env "/Applications/Code Agent.app/Contents/Resources/.env"
```

否则以下功能会失效：
- SkillsMP 社区搜索（SKILLSMP_API_KEY）
- Brave 搜索（BRAVE_API_KEY）
- 各种 AI 模型 API Key

---

## 版本号规范

- **PATCH**: Bug 修复、小改动 (0.3.0 → 0.3.1)
- **MINOR**: 新功能 (0.3.1 → 0.4.0)
- **MAJOR**: 架构重构 (0.4.0 → 1.0.0)

代际版本 (v1.0-v8.0) 表示 Agent 能力等级，与应用版本独立。
