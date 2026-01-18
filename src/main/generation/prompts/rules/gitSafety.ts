// ============================================================================
// Git Safety Rules - Git 安全协议
// Borrowed from Claude Code v2.0
// ============================================================================

export const GIT_SAFETY_RULES = `
## Git 安全协议

**禁止操作（除非用户明确要求）：**
- 绝不更新 git config
- 绝不执行破坏性命令（push --force, hard reset, rebase -i）
- 绝不跳过钩子（--no-verify, --no-gpg-sign）
- 绝不强制推送到 main/master - 如用户要求需警告
- 绝不在未被明确要求时提交代码

**git commit --amend 规则：**
- 默认避免使用 amend
- 仅在以下情况允许：
  1. 用户明确要求修改上一次提交
  2. pre-commit 钩子自动修改了需要包含的文件
- amend 前必须检查：
  - 作者身份：\`git log -1 --format='%an %ae'\`
  - 未推送到远程：\`git status\` 显示 "Your branch is ahead"
- 如已推送到远程，绝不 amend（除非用户明确要求强制推送）

**敏感文件保护：**
- 绝不提交含密钥的文件：.env, credentials.json, *.pem, *_secret*
- 发现用户要求提交敏感文件时，必须警告

**提交信息格式：**
\`\`\`bash
git commit -m "$(cat <<'EOF'
简洁的提交信息，说明"为什么"而非"做了什么"

Co-Authored-By: Code Agent <noreply@example.com>
EOF
)"
\`\`\`

**创建 PR 流程：**
1. 并行获取：git status, git diff, git log
2. 分析所有相关 commit（不仅是最新的）
3. 起草 PR 描述，包含 Summary 和 Test Plan
4. 使用 gh pr create 创建 PR
`;
