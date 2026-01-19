# 架构重构任务总览

> 版本：v1.0
> 日期：2025-01-19

## 任务依赖关系图

```
                    ┌─────────────────────┐
                    │      开始           │
                    └─────────┬───────────┘
                              │
              ┌───────────────┴───────────────┐
              ▼                               ▼
    ┌─────────────────┐             ┌─────────────────┐
    │ TASK-01         │             │ TASK-02         │
    │ 安全加固        │             │ 热更新系统      │
    │ (Agent-Security)│             │ (Agent-Cloud)   │
    │ 1 周            │             │ 2 周            │
    └────────┬────────┘             └────────┬────────┘
             │                                │
             │    ┌───────────────────────────┘
             │    │
             ▼    ▼
    ┌─────────────────┐
    │ TASK-03         │
    │ 主进程重构      │
    │ (Agent-Refactor)│
    │ 2 周            │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ TASK-04         │
    │ 接口规范化      │
    │ (Agent-Refactor)│
    │ 1 周            │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ TASK-05         │
    │ 编码规范统一    │
    │ (Agent-Quality) │
    │ 1 周            │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ TASK-06         │
    │ 扩展性增强      │
    │ (Agent-Extension)│
    │ 2 周            │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │ TASK-07         │
    │ 文档和测试      │
    │ (Agent-Docs)    │
    │ 1 周            │
    └────────┬────────┘
             │
             ▼
    ┌─────────────────┐
    │      完成       │
    └─────────────────┘
```

## 并行与串行规则

### 可并行任务

| 任务组 | 任务 | 原因 |
|-------|------|------|
| 第一批 | TASK-01 + TASK-02 | 无依赖，修改文件不重叠 |

### 串行依赖

| 任务 | 依赖 | 原因 |
|------|------|------|
| TASK-03 | TASK-02 | 需要 CloudConfigService 存在 |
| TASK-04 | TASK-03 | 需要目录结构重组完成 |
| TASK-05 | TASK-04 | 需要目录结构和接口稳定后再改名 |
| TASK-06 | TASK-05 | 需要命名规范统一后再加装饰器 |
| TASK-07 | TASK-06 | 需要所有代码稳定后写文档 |

## 任务文档索引

| 文档 | Agent | 优先级 | 状态 |
|------|-------|--------|------|
| [TASK-01-security.md](./TASK-01-security.md) | Agent-Security | P0 | 待执行 |
| [TASK-02-hot-update.md](./TASK-02-hot-update.md) | Agent-Cloud | P0 | 待执行 |
| [TASK-03-main-refactor.md](./TASK-03-main-refactor.md) | Agent-Refactor | P1 | 待执行 |
| [TASK-04-interface.md](./TASK-04-interface.md) | Agent-Refactor | P1 | 待执行 |
| [TASK-05-code-quality.md](./TASK-05-code-quality.md) | Agent-Quality | P2 | 待执行 |
| [TASK-06-extension.md](./TASK-06-extension.md) | Agent-Extension | P2 | 待执行 |
| [TASK-07-docs-test.md](./TASK-07-docs-test.md) | Agent-Docs | P2 | 待执行 |

## Agent 提示词索引

| 文档 | 用途 |
|------|------|
| [PROMPT-agent-security.md](./PROMPT-agent-security.md) | 安全加固 Agent 提示词 |
| [PROMPT-agent-cloud.md](./PROMPT-agent-cloud.md) | 热更新系统 Agent 提示词 |
| [PROMPT-agent-refactor.md](./PROMPT-agent-refactor.md) | 主进程重构 Agent 提示词 |
| [PROMPT-agent-quality.md](./PROMPT-agent-quality.md) | 代码质量 Agent 提示词 |
| [PROMPT-agent-extension.md](./PROMPT-agent-extension.md) | 扩展性增强 Agent 提示词 |
| [PROMPT-agent-docs.md](./PROMPT-agent-docs.md) | 文档测试 Agent 提示词 |

## 分支策略

```bash
main
 ├── feature/task-01-security      # Agent-Security
 ├── feature/task-02-hot-update    # Agent-Cloud
 │
 └── feature/task-03-refactor      # Agent-Refactor (从 main 合并 task-01 和 task-02 后拉取)
       └── feature/task-04-interface
             └── feature/task-05-quality
                   └── feature/task-06-extension
                         └── feature/task-07-docs
```

## 冲突预防规则

### 文件锁定表

| 阶段 | 锁定范围 | 可修改者 |
|------|---------|---------|
| TASK-01 执行中 | `package.json`, `src/main/services/SecureStorage.ts`, `src/main/tools/gen8/` | Agent-Security |
| TASK-02 执行中 | `vercel-api/`, `src/main/services/cloud/`, `src/main/services/PromptService.ts` | Agent-Cloud |
| TASK-03 执行中 | `src/main/` 全目录 | Agent-Refactor |
| TASK-05 执行中 | 全局文件重命名 | Agent-Quality |

### 交接检查清单

每个任务完成后，执行 Agent 必须确认：

1. [ ] 所有修改已 commit 并 push
2. [ ] `npm run typecheck` 通过
3. [ ] `npm run dev` 启动正常
4. [ ] 更新任务文档状态为「已完成」
5. [ ] 在任务文档底部填写「交接备注」

---

## 时间线

| 周 | 执行任务 | Agent |
|---|---------|-------|
| Week 1 | TASK-01 + TASK-02 并行 | Security + Cloud |
| Week 2 | TASK-02 继续 | Cloud |
| Week 3-4 | TASK-03 | Refactor |
| Week 5 | TASK-04 | Refactor |
| Week 6 | TASK-05 | Quality |
| Week 7-8 | TASK-06 | Extension |
| Week 9 | TASK-07 | Docs |

**总计：约 9 周**
