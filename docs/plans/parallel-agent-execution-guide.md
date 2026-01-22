# 并行 Agent 执行指南

> 如何使用多个 Claude Code Agent 并行完成重构任务

---

## 一、执行架构

### 1.1 Agent 角色定义

```
┌──────────────────────────────────────────────────────────────────┐
│                         主协调 Agent                              │
│  职责: 任务分配、进度追踪、冲突解决、代码审查协调                     │
└────────────────────────────┬─────────────────────────────────────┘
                             │
         ┌───────────────────┼───────────────────┐
         │                   │                   │
         ▼                   ▼                   ▼
┌─────────────────┐ ┌─────────────────┐ ┌─────────────────┐
│  Agent A        │ │  Agent B        │ │  Agent C        │
│  安全专家        │ │  工具专家        │ │  架构专家        │
│                 │ │                 │ │                 │
│  - 命令监控      │ │  - 文件跟踪      │ │  - Prompt 重构   │
│  - 沙箱隔离      │ │  - Token 估算   │ │  - Hooks 系统    │
│  - 权限模式      │ │  - 上下文压缩   │ │  - 子代理增强    │
│  - 审计日志      │ │  - 会话管理     │ │  - 配置管理      │
└─────────────────┘ └─────────────────┘ └─────────────────┘
         │                   │                   │
         └───────────────────┼───────────────────┘
                             │
                             ▼
                  ┌─────────────────┐
                  │  Agent D        │
                  │  质量专家        │
                  │                 │
                  │  - 单元测试      │
                  │  - 集成测试      │
                  │  - 文档更新      │
                  │  - 发布准备      │
                  └─────────────────┘
```

### 1.2 Git 分支策略

```
main
  │
  └── develop
        │
        ├── feature/phase1-security      (Agent A)
        │     ├── security/command-monitor
        │     ├── security/sensitive-detector
        │     └── security/audit-logger
        │
        ├── feature/phase1-tools         (Agent B)
        │     ├── tools/file-tracker
        │     ├── tools/quote-normalizer
        │     └── tools/grep-enhance
        │
        ├── feature/phase1-prompts       (Agent C)
        │     ├── prompts/injection-defense
        │     ├── prompts/tool-descriptions
        │     └── prompts/permission-levels
        │
        └── feature/phase1-tests         (Agent D)
              ├── tests/security
              ├── tests/tools
              └── tests/prompts
```

---

## 二、Phase 1 并行执行

### 2.1 启动命令

在 4 个独立的终端窗口中执行：

```bash
# 终端 1: Agent A - 安全专家
cd /Users/linchen/Downloads/ai/code-agent
git worktree add ~/.claude-worktrees/code-agent/agent-a-security feature/phase1-security -b feature/phase1-security
cd ~/.claude-worktrees/code-agent/agent-a-security
claude --resume  # 或新会话

# 终端 2: Agent B - 工具专家
cd /Users/linchen/Downloads/ai/code-agent
git worktree add ~/.claude-worktrees/code-agent/agent-b-tools feature/phase1-tools -b feature/phase1-tools
cd ~/.claude-worktrees/code-agent/agent-b-tools
claude --resume

# 终端 3: Agent C - 架构专家
cd /Users/linchen/Downloads/ai/code-agent
git worktree add ~/.claude-worktrees/code-agent/agent-c-prompts feature/phase1-prompts -b feature/phase1-prompts
cd ~/.claude-worktrees/code-agent/agent-c-prompts
claude --resume

# 终端 4: Agent D - 质量专家
cd /Users/linchen/Downloads/ai/code-agent
git worktree add ~/.claude-worktrees/code-agent/agent-d-tests feature/phase1-tests -b feature/phase1-tests
cd ~/.claude-worktrees/code-agent/agent-d-tests
claude --resume
```

### 2.2 Agent A 启动 Prompt

```markdown
# 任务: Phase 1 安全基础设施

你是 Agent A (安全专家)，负责建立运行时安全监控体系。

## 参考文档
- 实施计划: docs/plans/2026-01-22-claude-code-alignment-plan.md
- 参考实现: /tmp/claude-code-open/src/security/

## 任务清单
1. [A1] 创建运行时命令监控模块
   - 路径: src/main/security/commandMonitor.ts
   - 参考: /tmp/claude-code-open/src/security/validate.ts

2. [A2] 实现敏感信息检测器
   - 路径: src/main/security/sensitiveDetector.ts
   - 包含 20+ 种凭证模式检测

3. [A3] 建立 JSONL 审计日志系统
   - 路径: src/main/security/auditLogger.ts
   - 9 类事件分类

4. [A4] 集成到 toolExecutor
   - 修改: src/main/tools/toolExecutor.ts

5. [A5] 添加日志掩码功能
   - 路径: src/main/security/logMasker.ts

## 验收标准
- 所有 Bash 命令有审计日志
- 敏感信息自动掩码
- 单元测试覆盖率 > 80%

## 协作约定
- 完成每个任务后立即 commit
- commit 消息格式: `feat(security): [A1] add command monitor`
- 有接口变更时更新 src/shared/types/
- 完成后通知 Agent D 编写测试

开始执行任务 A1。
```

### 2.3 Agent B 启动 Prompt

```markdown
# 任务: Phase 1 工具实现增强

你是 Agent B (工具专家)，负责对齐 claude-code-open 的工具能力。

## 参考文档
- 实施计划: docs/plans/2026-01-22-claude-code-alignment-plan.md
- 参考实现: /tmp/claude-code-open/src/tools/

## 任务清单
1. [B1] 实现文件读取跟踪器
   - 路径: src/main/tools/fileReadTracker.ts
   - 防止编辑未读文件

2. [B2] 添加智能引号规范化
   - 路径: src/main/tools/utils/quoteNormalizer.ts
   - 处理弯引号、em-dash 等

3. [B3] 实现外部修改检测
   - 路径: src/main/tools/utils/externalModificationDetector.ts
   - 基于 mtime 比较

4. [B4] 后台任务持久化
   - 路径: src/main/tools/backgroundTaskPersistence.ts
   - 任务日志: ~/.code-agent/tasks/

5. [B5] 集成到 edit_file 工具
   - 修改: src/main/tools/gen1/edit_file.ts

6. [B6] 增强 Grep 参数支持
   - 修改: src/main/tools/gen2/grep.ts
   - 添加 -B, -A, -C, output_mode

## 验收标准
- Edit 工具检测外部修改
- 智能引号正确处理
- 后台任务可恢复

## 协作约定
- 完成每个任务后立即 commit
- commit 消息格式: `feat(tools): [B1] add file read tracker`
- 完成后通知 Agent D 编写测试

开始执行任务 B1。
```

### 2.4 Agent C 启动 Prompt

```markdown
# 任务: Phase 1 System Prompt 重构

你是 Agent C (架构专家)，负责建立分层安全框架和详细工具描述。

## 参考文档
- 实施计划: docs/plans/2026-01-22-claude-code-alignment-plan.md
- 参考实现: https://github.com/Piebald-AI/claude-code-system-prompts

## 任务清单
1. [C1] 拆分注入防御为 3 层
   - 路径: src/main/generation/prompts/rules/injection/
   - core.ts, verification.ts, meta.ts

2. [C2] 创建详细 Bash 工具描述
   - 路径: src/main/generation/prompts/tools/bash.ts
   - ~1000 tokens，含示例和禁用场景

3. [C3] 创建详细 Edit 工具描述
   - 路径: src/main/generation/prompts/tools/edit.ts

4. [C4] 创建详细 Task 工具描述
   - 路径: src/main/generation/prompts/tools/task.ts

5. [C5] 实现权限等级架构
   - 路径: src/main/generation/prompts/rules/permissionLevels.ts
   - Prohibited / Explicit / Regular

6. [C6] 添加社工防御规则
   - 路径: src/main/generation/prompts/rules/socialEngineering.ts

7. [C7] 更新 builder.ts 集成
   - 修改: src/main/generation/prompts/builder.ts

## 验收标准
- 注入防御分 3 层
- 每个工具描述含"何时不使用"
- Gen3+ 包含所有安全规则

## 协作约定
- 完成每个任务后立即 commit
- commit 消息格式: `feat(prompts): [C1] split injection defense`
- 完成后通知 Agent D 编写测试

开始执行任务 C1。
```

### 2.5 Agent D 启动 Prompt

```markdown
# 任务: Phase 1 测试覆盖

你是 Agent D (质量专家)，负责为新增功能建立测试。

## 参考文档
- 实施计划: docs/plans/2026-01-22-claude-code-alignment-plan.md

## 任务清单
1. [D1] 安全模块单元测试
   - 路径: tests/unit/security/
   - 等待 Agent A 完成 A1-A5

2. [D2] 工具增强单元测试
   - 路径: tests/unit/tools/
   - 等待 Agent B 完成 B1-B6

3. [D3] Prompt 构建测试
   - 路径: tests/unit/prompts/
   - 等待 Agent C 完成 C1-C7

4. [D4] 集成测试框架搭建
   - 路径: tests/integration/setup.ts
   - 可立即开始

5. [D5] E2E 安全场景测试
   - 路径: tests/e2e/security.spec.ts
   - 依赖 D4

## 执行顺序
1. 立即开始 D4 (无依赖)
2. 监控 Agent A/B/C 进度
3. 当有模块完成时，立即编写对应测试
4. 最后执行 D5 E2E 测试

## 验收标准
- 测试覆盖率 > 70%
- 所有测试通过
- 有清晰的测试文档

## 协作约定
- 定期检查其他 Agent 的 commit
- 测试失败时立即通知对应 Agent
- commit 消息格式: `test(security): [D1] add command monitor tests`

开始执行任务 D4（集成测试框架）。
```

---

## 三、同步与合并

### 3.1 每日同步流程

```bash
# 每个 Agent 在开始工作前执行
git fetch origin
git rebase origin/develop

# 完成任务后
git push origin feature/phase1-xxx

# 主协调者合并到 develop
git checkout develop
git merge feature/phase1-security --no-ff
git merge feature/phase1-tools --no-ff
git merge feature/phase1-prompts --no-ff
git merge feature/phase1-tests --no-ff
git push origin develop
```

### 3.2 冲突解决

```bash
# 如果有冲突
git checkout feature/phase1-xxx
git rebase origin/develop
# 解决冲突
git add .
git rebase --continue
git push origin feature/phase1-xxx --force-with-lease
```

### 3.3 代码审查

每个 PR 需要：
1. 对应 Agent 自测通过
2. Agent D 测试覆盖
3. 至少一个其他 Agent 审查

---

## 四、进度追踪模板

### 4.1 每日状态报告

```markdown
# 日期: 2026-01-XX

## Agent A (安全)
- 完成: A1, A2
- 进行中: A3
- 阻塞: 无
- 下一步: A4

## Agent B (工具)
- 完成: B1
- 进行中: B2, B3
- 阻塞: 无
- 下一步: B4

## Agent C (架构)
- 完成: C1, C2
- 进行中: C3
- 阻塞: 无
- 下一步: C4

## Agent D (质量)
- 完成: D4
- 进行中: D1 (等待 A1-A5)
- 阻塞: 等待 Agent A
- 下一步: D2

## 集成状态
- develop 分支: 绿色
- CI 状态: 通过
- 下次合并: 今天 18:00
```

### 4.2 里程碑检查点

| 里程碑 | 日期 | 状态 | 验收人 |
|--------|------|------|--------|
| Phase 1 安全基础 | Week 1 End | [ ] | Agent D |
| Phase 1 工具增强 | Week 1 End | [ ] | Agent D |
| Phase 1 Prompt 重构 | Week 2 End | [ ] | Agent D |
| Phase 1 测试完成 | Week 2 End | [ ] | 主协调 |
| v0.8.30 发布 | Week 2 End | [ ] | 主协调 |

---

## 五、常见问题

### Q1: Agent 之间如何通信？

使用共享文件：
```
docs/plans/agent-sync/
├── agent-a-status.md
├── agent-b-status.md
├── agent-c-status.md
├── agent-d-status.md
└── blockers.md
```

每个 Agent 定期更新自己的状态文件，其他 Agent 可以读取。

### Q2: 接口变更如何协调？

1. 在 `src/shared/types/` 中定义接口
2. 修改接口的 Agent 负责通知所有依赖方
3. 使用 TypeScript 编译检查依赖

### Q3: 测试失败如何处理？

1. Agent D 发现测试失败
2. 在 `docs/plans/agent-sync/blockers.md` 中记录
3. 对应 Agent 立即修复
4. 修复后通知 Agent D 重新测试

### Q4: 如何处理大文件冲突？

1. 尽量避免多个 Agent 同时修改同一文件
2. 如果必须修改，提前协调时间
3. 使用 `git rerere` 记住冲突解决方案

---

## 六、工具推荐

### 6.1 并行终端管理

```bash
# 使用 tmux
tmux new-session -d -s agents
tmux split-window -h
tmux split-window -v
tmux select-pane -t 0
tmux split-window -v

# 或使用 iTerm2 的 Arrangement 功能
```

### 6.2 进度可视化

```bash
# 查看所有分支状态
git branch -a --list 'feature/phase1-*' -v

# 查看 commit 历史
git log --oneline --graph --all --decorate | head -30

# 查看文件变更
git diff develop..feature/phase1-security --stat
```

### 6.3 CI/CD 检查

```bash
# 本地运行测试
npm run test

# 类型检查
npm run typecheck

# 构建验证
npm run build
```

---

## 七、执行清单

### Phase 1 启动清单

- [ ] 创建 4 个 git worktree
- [ ] 启动 4 个 Claude Code 会话
- [ ] 发送对应的启动 Prompt
- [ ] 创建 agent-sync 目录
- [ ] 设置每日同步时间

### Phase 1 完成清单

- [ ] 所有任务 commit 完成
- [ ] 所有测试通过
- [ ] 代码审查完成
- [ ] 合并到 develop
- [ ] 更新 CHANGELOG
- [ ] 发布 v0.8.30
