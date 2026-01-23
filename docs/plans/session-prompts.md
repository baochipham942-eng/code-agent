# Code Agent 重构会话提示词

> 基于 `2026-01-22-claude-code-alignment-plan.md` 拆分的会话启动提示词

## 会话拆分策略

### 推荐方案：4 个并行会话

考虑到任务依赖和上下文管理，建议拆分为 **4 个独立会话**：

| 会话 | 职责 | 预计轮次 | Git 分支 |
|------|------|---------|---------|
| Session A | 安全基础设施（Phase 1-3 安全相关） | 15-20 | `feature/security` |
| Session B | 工具增强 + 上下文管理 | 15-20 | `feature/tools-context` |
| Session C | Prompt 增强 + Hooks 系统 | 12-15 | `feature/prompts-hooks` |
| Session D | 测试 + 文档 + 发布 | 10-15 | `feature/quality` |

### 执行顺序

```
Week 1-2 (Phase 1):
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Session A   │  │ Session B   │  │ Session C   │
│ A1-A5       │  │ B1-B6       │  │ C1-C4,C8    │
│ 安全基础    │  │ 工具增强    │  │ Prompt增强  │
└─────────────┘  └─────────────┘  └─────────────┘
        ↓               ↓               ↓
                ┌─────────────┐
                │ Session D   │
                │ D1-D5 测试  │
                └─────────────┘

Week 3-4 (Phase 2):
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Session A   │  │ Session B   │  │ Session C   │
│ A6-A10      │  │ B7-B11      │  │ C8-C13      │
│ 沙箱隔离    │  │ 上下文管理  │  │ Hooks系统   │
└─────────────┘  └─────────────┘  └─────────────┘
        ↓               ↓               ↓
                ┌─────────────┐
                │ Session D   │
                │ D6-D10 文档 │
                └─────────────┘

Week 5-6 (Phase 3):
┌─────────────┐  ┌─────────────┐  ┌─────────────┐
│ Session A   │  │ Session B   │  │ Session C   │
│ A11-A15     │  │ B12-B16     │  │ C14-C17     │
│ 子代理增强  │  │ 会话功能    │  │ 集成优化    │
└─────────────┘  └─────────────┘  └─────────────┘
        ↓               ↓               ↓
                ┌─────────────┐
                │ Session D   │
                │ D11-D15发布 │
                └─────────────┘
```

---

## Session A: 安全基础设施

### Phase 1 启动提示词

```markdown
# 任务: Code Agent 安全基础设施 (Phase 1)

你是安全专家，负责为 Code Agent 建立运行时安全监控体系。

## 背景
- 项目路径: ~/Downloads/ai/code-agent
- 参考实现: https://github.com/lookfree/claude-code-open (已克隆到 /tmp/claude-code-open)
- 详细计划: docs/plans/2026-01-22-claude-code-alignment-plan.md

## 本次任务 (A1-A5)

### A1: 运行时命令监控
创建 `src/main/security/commandMonitor.ts`:
- preExecute(command): 执行前验证
- monitor(pid): 执行中监控（可选）
- postExecute(result): 执行后审计

### A2: 敏感信息检测器
创建 `src/main/security/sensitiveDetector.ts`:
- 检测 20+ 种敏感模式（API Key、AWS Secret、GitHub Token 等）
- 返回检测位置和类型

### A3: JSONL 审计日志
创建 `src/main/security/auditLogger.ts`:
- 记录所有工具执行
- 存储到 ~/.code-agent/audit/YYYY-MM-DD.jsonl
- 支持按时间范围查询

### A4: 集成到 toolExecutor
修改 `src/main/tools/toolExecutor.ts`:
- 执行前调用 commandMonitor.preExecute
- 执行后调用 auditLogger.log

### A5: 日志掩码
创建 `src/main/security/logMasker.ts`:
- 使用 sensitiveDetector 自动掩码敏感信息
- 显示为 `***REDACTED***`

## 技术规格

```typescript
// 审计日志格式
interface AuditEntry {
  timestamp: number;
  eventType: 'tool_usage' | 'permission_check' | 'file_access' | 'security_incident';
  sessionId: string;
  toolName: string;
  input: Record<string, unknown>;
  output?: string;
  duration: number;
  success: boolean;
  securityFlags?: string[];
}

// 敏感模式示例
const SENSITIVE_PATTERNS = {
  apiKey: /(?:api[_-]?key|apikey)[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  awsSecret: /(?:aws[_-]?secret|secret[_-]?key)[=:]\s*['"]?([a-zA-Z0-9/+=]{40})['"]?/gi,
  githubToken: /gh[ps]_[a-zA-Z0-9]{36,}/g,
};
```

## 验收标准
- [ ] 所有 Bash 命令执行都记录审计日志
- [ ] 敏感信息在日志中自动掩码
- [ ] 单元测试覆盖率 > 80%

## 工作流程
1. 先阅读现有代码了解结构
2. 创建 src/main/security/ 目录
3. 按 A1 → A2 → A3 → A5 → A4 顺序实现
4. 每完成一个模块立即 commit
5. commit 格式: `feat(security): [A1] add command monitor`

## Git 分支
```bash
git checkout -b feature/security
```

开始执行任务 A1。
```

### Phase 2 启动提示词

```markdown
# 任务: Code Agent 沙箱隔离系统 (Phase 2)

你是安全专家，继续 Phase 1 的工作，实现多平台进程隔离。

## 背景
- Phase 1 已完成: A1-A5 (命令监控、敏感检测、审计日志)
- 当前分支: feature/security

## 本次任务 (A6-A10)

### A6: Linux Bubblewrap 集成
创建 `src/main/sandbox/bubblewrap.ts`:
- 检测 bwrap 是否可用
- 配置网络、文件系统权限
- 执行隔离命令

### A7: macOS Seatbelt 集成
创建 `src/main/sandbox/seatbelt.ts`:
- 生成 Seatbelt profile
- 支持动态权限配置
- 执行沙箱命令

### A8: 沙箱管理器
创建 `src/main/sandbox/manager.ts`:
- 自动检测平台
- 选择合适的沙箱实现
- 提供统一 API

### A9: 6 种权限模式
创建 `src/main/permissions/modes.ts`:
- default: 标准提示
- acceptEdits: 自动接受编辑
- dontAsk: 自动拒绝
- bypassPermissions: 跳过检查
- plan: 规划模式
- delegate: 委派模式

### A10: 权限策略引擎
创建 `src/main/permissions/policyEngine.ts`:
- 根据模式评估权限
- 支持规则优先级
- 审计权限决策

## 技术规格

```typescript
// Bubblewrap 配置
interface BubblewrapConfig {
  allowNetwork: boolean;
  readOnlyPaths: string[];
  readWritePaths: string[];
  tmpfs: string[];
  unshareAll: boolean;
}

// 权限模式
type PermissionMode = 'default' | 'acceptEdits' | 'dontAsk' | 'bypassPermissions' | 'plan' | 'delegate';
```

## 验收标准
- [ ] Linux 上 Bubblewrap 正常工作（或优雅降级）
- [ ] macOS 上 Seatbelt 正常工作
- [ ] 权限模式切换正常

开始执行任务 A6。
```

### Phase 3 启动提示词

```markdown
# 任务: Code Agent 子代理架构升级 (Phase 3)

你是安全专家，完成最后阶段的子代理权限和委派功能。

## 背景
- Phase 1-2 已完成: 安全基础 + 沙箱隔离
- 当前分支: feature/security

## 本次任务 (A11-A15)

### A11: Agent 描述字段
修改 `src/main/agent/types.ts`:
- 添加 description 字段到 Agent 类型
- 用于自动委派匹配

### A12: 自动委派匹配器
创建 `src/main/agent/autoDelegator.ts`:
- 解析任务描述
- 匹配合适的 Agent
- 返回委派建议

### A13: 子代理会话持久化
创建 `src/main/agent/sessionPersistence.ts`:
- 保存子代理状态到磁盘
- 支持跨进程恢复

### A14: Resume 命令
创建 `src/main/agent/resume.ts`:
- 从持久化状态恢复
- 重建上下文

### A15: 子代理权限模式
创建 `src/main/agent/permissions.ts`:
- 继承父代理权限
- 支持权限收缩

## 验收标准
- [ ] 子代理可以自动委派
- [ ] 会话可以持久化和恢复
- [ ] 权限继承正确

完成后合并到 develop 分支。
```

---

## Session B: 工具增强 + 上下文管理

### Phase 1 启动提示词

```markdown
# 任务: Code Agent 工具增强 (Phase 1)

你是工具专家，负责增强文件操作和工具能力。

## 背景
- 项目路径: ~/Downloads/ai/code-agent
- 参考实现: /tmp/claude-code-open/src/tools/
- 详细计划: docs/plans/2026-01-22-claude-code-alignment-plan.md

## 本次任务 (B1-B6)

### B1: 文件读取跟踪器
创建 `src/main/tools/fileReadTracker.ts`:
- 记录文件读取时间和 mtime
- 检查是否已读取过
- 检测外部修改

### B2: 智能引号规范化
创建 `src/main/tools/utils/quoteNormalizer.ts`:
- 转换弯引号为直引号
- 支持模糊匹配

### B3: 外部修改检测
创建 `src/main/tools/utils/externalModificationDetector.ts`:
- 比较当前 mtime 和记录的 mtime
- 返回是否被修改

### B4: 后台任务持久化
创建 `src/main/tools/backgroundTaskPersistence.ts`:
- 保存运行中的任务信息
- 进程重启后可恢复

### B5: 集成到 edit_file
修改 `src/main/tools/gen1/edit_file.ts`:
- 检查文件是否已读取
- 检测外部修改并告警
- 使用引号规范化匹配

### B6: 增强 Grep 参数
修改 `src/main/tools/gen2/grep.ts`:
- 添加 -A/-B/-C 上下文行支持
- 添加 --type 文件类型过滤

## 技术规格

```typescript
// 智能引号映射
const SMART_QUOTE_MAP: Record<string, string> = {
  '\u2018': "'",  // '
  '\u2019': "'",  // '
  '\u201C': '"',  // "
  '\u201D': '"',  // "
};

// 文件跟踪
class FileReadTracker {
  private readFiles: Map<string, { mtime: number; readTime: number }>;
  recordRead(filePath: string, mtime: number): void;
  hasBeenRead(filePath: string): boolean;
  checkExternalModification(filePath: string, currentMtime: number): boolean;
}
```

## 验收标准
- [ ] Edit 在文件未读取时返回错误
- [ ] 弯引号能正确匹配
- [ ] 外部修改有告警

## Git 分支
```bash
git checkout -b feature/tools-context
```

开始执行任务 B1。
```

### Phase 2 启动提示词

```markdown
# 任务: Code Agent 上下文管理系统 (Phase 2)

你是工具专家，实现 Token 估算和增量压缩。

## 背景
- Phase 1 已完成: B1-B6 (文件跟踪、引号规范化)
- 当前分支: feature/tools-context

## 本次任务 (B7-B11)

### B7: Token 精确估算器
创建 `src/main/context/tokenEstimator.ts`:
- 多维度估算（中文/英文/代码不同比率）
- 中文约 2.0 字符/token
- 英文约 3.5 字符/token
- 代码约 3.0 字符/token

### B8: 增量压缩引擎
创建 `src/main/context/compressor.ts`:
- 支持多种压缩策略
- truncate: 简单截断
- ai_summary: AI 摘要
- code_extract: 保留代码块

### B9: 代码块智能保留
创建 `src/main/context/codePreserver.ts`:
- 识别代码块边界
- 压缩时保护完整代码块
- 保留最近的代码修改

### B10: 会话本地缓存
创建 `src/main/session/localCache.ts`:
- 缓存历史消息
- 支持按会话 ID 查询
- 实现 LRU 淘汰

### B11: AI 摘要生成器
创建 `src/main/context/summarizer.ts`:
- 调用 AI 生成摘要
- 保留关键信息
- 控制摘要长度

## 技术规格

```typescript
// Token 估算
function estimateTokens(text: string): number {
  const hasAsian = /[\u4e00-\u9fa5]/.test(text);
  const hasCode = /```|function\s|class\s/.test(text);

  let charsPerToken = 3.5;
  if (hasAsian) charsPerToken = 2.0;
  else if (hasCode) charsPerToken = 3.0;

  return Math.ceil(text.length / charsPerToken);
}

// 压缩策略
interface CompressionStrategy {
  type: 'truncate' | 'ai_summary' | 'code_extract';
  threshold: number;
  targetRatio: number;
}
```

## 验收标准
- [ ] Token 估算误差 < 10%
- [ ] 压缩节省 > 30% token
- [ ] 代码块不被截断

开始执行任务 B7。
```

### Phase 3 启动提示词

```markdown
# 任务: Code Agent 会话高级功能 (Phase 3)

你是工具专家，实现 Fork/Resume 和导出功能。

## 背景
- Phase 1-2 已完成
- 当前分支: feature/tools-context

## 本次任务 (B12-B16)

### B12: 会话 Fork
创建 `src/main/session/fork.ts`:
- 复制当前会话状态
- 创建新会话 ID
- 保持独立演进

### B13: 会话 Resume
创建 `src/main/session/resume.ts`:
- 从历史会话恢复
- 重建上下文
- 继续对话

### B14: Markdown 导出
创建 `src/main/session/exportMarkdown.ts`:
- 导出对话为 Markdown
- 包含工具调用记录
- 格式化代码块

### B15: 会话搜索
创建 `src/main/session/search.ts`:
- 搜索历史消息
- 支持关键词和时间范围

### B16: 成本统计
创建 `src/main/session/costReport.ts`:
- 统计 Token 用量
- 计算 API 成本
- 生成报告

## 验收标准
- [ ] Fork/Resume 正常工作
- [ ] 导出格式正确
- [ ] 成本统计准确

完成后合并到 develop 分支。
```

---

## Session C: Prompt 增强 + Hooks 系统

### Phase 1 启动提示词

```markdown
# 任务: Code Agent Prompt 增强 (Phase 1)

你是架构专家，负责增强 System Prompt 和工具描述。

## 背景
- 项目路径: ~/Downloads/ai/code-agent
- 参考实现: https://github.com/Piebald-AI/claude-code-system-prompts
- 详细计划: docs/plans/2026-01-22-claude-code-alignment-plan.md

## 重要: 宪法架构已完成

主仓库已完成"宪法式 System Prompt 架构改造"：
- `constitution/` 目录已创建（soul, values, ethics, safety, judgment）
- `builder.ts` 已更新为：宪法 → 代际工具 → 规则

原 C5 (权限等级) 和 C6 (社工防御) 已通过宪法层完成。

## 本次任务 (C1-C4, C8)

### C1: 注入防御三层分离
创建 `src/main/generation/prompts/rules/injection/`:
- core.ts: 基础指令来源验证
- verification.ts: 验证响应流程
- meta.ts: 规则不可修改性

### C2: 详细 Bash 工具描述
创建 `src/main/generation/prompts/tools/bash.ts`:
- 参数详解（command, timeout, cwd）
- 使用示例（5-10 个场景）
- 何时不使用（文件操作用专门工具）
- 约 1000 tokens

### C3: 详细 Edit 工具描述
创建 `src/main/generation/prompts/tools/edit.ts`:
- 参数详解
- 使用示例
- 错误处理指南

### C4: 详细 Task 工具描述
创建 `src/main/generation/prompts/tools/task.ts`:
- 子代理类型说明
- 使用场景
- 最佳实践

### C8: 集成到 builder
修改 `src/main/generation/prompts/builder.ts`:
- 在代际工具层和规则层之间插入详细描述
- 按工具可用性条件包含

## 参考格式

```typescript
// 工具描述格式
export const BASH_TOOL_DESCRIPTION = `
## Bash 工具

执行 shell 命令并返回结果。

### 参数
- command (必填): 要执行的命令
- timeout (可选): 超时时间，默认 120000ms
- cwd (可选): 工作目录

### 使用示例

<example>
运行测试:
bash { "command": "npm test" }
</example>

<example>
检查 Git 状态:
bash { "command": "git status" }
</example>

### 何时不使用
- 读取文件内容 → 使用 read_file
- 搜索文件 → 使用 glob 或 grep
- 编辑文件 → 使用 edit_file
`;
```

## Git 分支
```bash
git checkout -b feature/prompts-hooks
```

开始执行任务 C1。
```

### Phase 2 启动提示词

```markdown
# 任务: Code Agent Hooks 系统 (Phase 2)

你是架构专家，实现用户可配置的 Hook 系统。

## 背景
- Phase 1 已完成: Prompt 增强
- 当前分支: feature/prompts-hooks

## 本次任务 (C9-C13)

注意: C8 已在 Phase 1 用于工具描述集成，这里从 C9 开始。

### C9: Hook 配置解析器
创建 `src/main/hooks/configParser.ts`:
- 解析 .claude/settings.json 中的 hooks 配置
- 验证配置格式
- 返回结构化的 Hook 定义

### C10: Bash 脚本执行引擎
创建 `src/main/hooks/scriptExecutor.ts`:
- 执行外部脚本
- 传递环境变量
- 处理超时

### C11: 扩展事件类型（11种）
创建 `src/main/hooks/events.ts`:
- PreToolUse, PostToolUse, PostToolUseFailure
- UserPromptSubmit, Stop, SubagentStop
- PreCompact, Setup
- SessionStart, SessionEnd, Notification

### C12: 多源 Hook 合并
创建 `src/main/hooks/merger.ts`:
- 合并全局和项目级 hooks
- 处理优先级
- 去重

### C13: Prompt-Based Hook
创建 `src/main/hooks/promptHook.ts`:
- 使用 AI 评估的 Hook
- 支持动态 prompt
- 返回 allow/block/continue

### C14: 重构 HooksEngine
修改 `src/main/planning/hooksEngine.ts`:
- 集成新的 Hook 系统
- 支持所有事件类型
- 保持向后兼容

## 配置格式

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write",
        "hooks": [
          {
            "type": "command",
            "command": "./security-check.sh",
            "timeout": 5000
          }
        ]
      }
    ]
  }
}
```

## 验收标准
- [ ] 配置正确解析
- [ ] 外部脚本可执行
- [ ] 11 种事件类型支持

开始执行任务 C9。
```

### Phase 3 启动提示词

```markdown
# 任务: Code Agent 集成优化 (Phase 3)

你是架构专家，完成性能优化和错误处理。

## 背景
- Phase 1-2 已完成
- 当前分支: feature/prompts-hooks

## 本次任务 (C15-C17)

### C15: 性能 Profiling
- 使用 Chrome DevTools 分析 Electron 性能
- 找出瓶颈点
- 记录基准数据

### C16: 内存泄漏检测
- 检查事件监听器泄漏
- 检查定时器清理
- 检查大对象引用

### C17: 错误边界完善
创建/修改 `src/main/errors/`:
- 统一错误类型
- 错误恢复策略
- 用户友好提示

### C18: 回归测试
创建 `tests/regression/`:
- 核心功能回归测试
- 性能回归测试
- 兼容性测试

## 验收标准
- [ ] 无明显性能退化
- [ ] 无内存泄漏
- [ ] 错误处理完善

完成后合并到 develop 分支。
```

---

## Session D: 测试 + 文档 + 发布

### Phase 1 启动提示词

```markdown
# 任务: Code Agent 测试覆盖 (Phase 1)

你是质量专家，负责为新功能建立测试。

## 背景
- 项目路径: ~/Downloads/ai/code-agent
- 详细计划: docs/plans/2026-01-22-claude-code-alignment-plan.md

## 依赖关系
本会话需要等待其他会话完成对应模块后才能编写测试：
- D1 等待 Session A 完成 A1-A5
- D2 等待 Session B 完成 B1-B6
- D3 等待 Session C 完成 C1-C4

## 本次任务 (D1-D5)

### D1: 安全模块单元测试
创建 `tests/unit/security/`:
- commandMonitor.test.ts
- sensitiveDetector.test.ts
- auditLogger.test.ts
- logMasker.test.ts

### D2: 工具增强单元测试
创建 `tests/unit/tools/`:
- fileReadTracker.test.ts
- quoteNormalizer.test.ts
- externalModificationDetector.test.ts

### D3: Prompt 构建测试
创建 `tests/unit/prompts/`:
- builder.test.ts
- injection.test.ts

### D4: 集成测试框架
创建 `tests/integration/setup.ts`:
- 测试环境初始化
- Mock 服务配置
- 清理函数

### D5: E2E 安全场景测试
创建 `tests/e2e/security.spec.ts`:
- 敏感信息检测场景
- 审计日志记录场景
- 权限检查场景

## 测试规范

```typescript
describe('SensitiveDetector', () => {
  it('should detect API keys', () => {
    const text = 'api_key=sk-1234567890abcdef';
    expect(detector.detect(text)).toContainEqual({
      type: 'apiKey',
      masked: 'api_key=***REDACTED***'
    });
  });

  it('should not false positive', () => {
    const text = 'This is normal text';
    expect(detector.detect(text)).toHaveLength(0);
  });
});
```

## 执行顺序
1. 立即开始 D4（无依赖）
2. 监控其他 Session 进度
3. 模块完成后立即编写测试

## Git 分支
```bash
git checkout -b feature/quality
```

先执行 D4，同时等待其他 Session。
```

### Phase 2 启动提示词

```markdown
# 任务: Code Agent 文档更新 (Phase 2)

你是质量专家，更新文档和迁移指南。

## 背景
- Phase 1 已完成: 基础测试
- 当前分支: feature/quality

## 本次任务 (D6-D10)

### D6: API 文档更新
更新 `docs/api/`:
- 安全模块 API
- 工具增强 API
- Hooks API

### D7: 迁移指南
创建 `docs/migration/v0.9-upgrade.md`:
- 配置文件变更
- API 变更
- 破坏性改动

### D8: CHANGELOG 更新
更新 `CHANGELOG.md`:
- 新功能列表
- Bug 修复
- 破坏性变更

### D9: CLAUDE.md 更新
更新 `CLAUDE.md`:
- 新增工具说明
- 新增配置项
- 更新目录结构

### D10: 示例代码
更新 `examples/`:
- 安全配置示例
- Hooks 配置示例
- 上下文管理示例

## 验收标准
- [ ] 所有新 API 有文档
- [ ] 迁移指南清晰
- [ ] 示例代码可运行

开始执行 D6。
```

### Phase 3 启动提示词

```markdown
# 任务: Code Agent 发布准备 (Phase 3)

你是质量专家，完成最终发布准备。

## 背景
- Phase 1-2 已完成
- 所有功能开发完成
- 当前分支: feature/quality

## 本次任务 (D11-D15)

### D11: 版本号更新
修改 `package.json`:
- 更新版本号为 0.9.0
- 更新 vercel-api/api/update.ts

### D12: 构建验证
```bash
npm run typecheck
npm run build
```

### D13: 打包测试
```bash
npm run dist:mac
```
验证应用正常启动和运行。

### D14: 发布说明
创建 `docs/releases/v0.9.0.md`:
- 主要新功能
- 改进项
- 已知问题

### D15: 发布
- 合并所有分支到 main
- 创建 Git Tag
- 触发发布流程

## 发布清单

```
□ 所有分支已合并到 develop
□ develop 测试通过
□ develop 合并到 main
□ npm run typecheck 通过
□ npm run build 通过
□ npm run dist:mac 通过
□ vercel-api 部署成功
□ Git tag v0.9.0 创建
□ 发布说明完成
```

执行最终发布流程。
```

---

## 快速启动命令

### 创建 4 个 Worktree

```bash
cd ~/Downloads/ai/code-agent

# Session A: 安全
git worktree add ~/.claude-worktrees/code-agent/security feature/security

# Session B: 工具+上下文
git worktree add ~/.claude-worktrees/code-agent/tools-context feature/tools-context

# Session C: Prompt+Hooks
git worktree add ~/.claude-worktrees/code-agent/prompts-hooks feature/prompts-hooks

# Session D: 质量
git worktree add ~/.claude-worktrees/code-agent/quality feature/quality
```

### 启动会话

```bash
# 终端 1 - Session A
cd ~/.claude-worktrees/code-agent/security
claude

# 终端 2 - Session B
cd ~/.claude-worktrees/code-agent/tools-context
claude

# 终端 3 - Session C
cd ~/.claude-worktrees/code-agent/prompts-hooks
claude

# 终端 4 - Session D
cd ~/.claude-worktrees/code-agent/quality
claude
```

---

## 协调注意事项

1. **每日同步**: 每天开始时检查各分支进度
2. **依赖等待**: Session D 需要等待其他 Session 完成对应模块
3. **冲突解决**: 修改 shared/types 时需要协调
4. **合并顺序**: A → B → C → D 依次合并到 develop
