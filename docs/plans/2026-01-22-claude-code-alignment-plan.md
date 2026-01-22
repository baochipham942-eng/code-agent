# Code Agent 对标 Claude Code 重构计划

> 基于 claude-code-open (v2.0.76) 和 claude-code-system-prompts (v2.1.15) 的深度分析

**创建日期**: 2026-01-22
**预计周期**: 4-6 周
**并行 Agent 数**: 4-6 个

---

## 一、执行摘要

### 1.1 目标

将 Code Agent 的核心能力对标官方 Claude Code，重点改进：
- 安全体系（沙箱、权限、审计）
- 上下文管理（Token 估算、压缩、会话持久化）
- System Prompt 质量（分层防御、详细工具描述）
- Hooks 系统（用户可配置、外部脚本执行）
- 子代理架构（自动委派、持久化）

### 1.2 原则

- **保留优势**：真并行执行、共享发现、深度研究模式
- **补齐短板**：安全、上下文管理、易用性
- **增量交付**：每个 Phase 可独立发布

### 1.3 并行策略

```
┌─────────────────────────────────────────────────────────────────┐
│                        Phase 1 (Week 1-2)                        │
├────────────────┬────────────────┬────────────────┬──────────────┤
│   Agent A      │    Agent B     │    Agent C     │   Agent D    │
│   安全基础      │   工具增强      │   Prompt 重构   │   测试覆盖   │
├────────────────┼────────────────┼────────────────┼──────────────┤
│ - 命令监控      │ - 文件跟踪器    │ - 注入防御分层  │ - 单元测试   │
│ - 敏感信息检测  │ - 引号规范化    │ - 工具描述详化  │ - 集成测试   │
│ - 审计日志      │ - 外部修改检测  │ - 权限架构      │ - E2E 测试   │
└────────────────┴────────────────┴────────────────┴──────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        Phase 2 (Week 3-4)                        │
├────────────────┬────────────────┬────────────────┬──────────────┤
│   Agent A      │    Agent B     │    Agent C     │   Agent D    │
│   沙箱隔离      │   上下文管理    │   Hooks 系统   │   文档更新   │
├────────────────┼────────────────┼────────────────┼──────────────┤
│ - Bubblewrap   │ - Token 估算   │ - 配置解析     │ - API 文档   │
│ - Seatbelt     │ - 增量压缩     │ - 脚本执行     │ - 迁移指南   │
│ - 权限模式      │ - 会话缓存     │ - 11 事件类型  │ - CHANGELOG  │
└────────────────┴────────────────┴────────────────┴──────────────┘

┌─────────────────────────────────────────────────────────────────┐
│                        Phase 3 (Week 5-6)                        │
├────────────────┬────────────────┬────────────────┬──────────────┤
│   Agent A      │    Agent B     │    Agent C     │   Agent D    │
│   子代理增强    │   会话高级功能  │   集成优化     │   发布准备   │
├────────────────┼────────────────┼────────────────┼──────────────┤
│ - 自动委派      │ - Fork/Resume  │ - 性能优化     │ - 版本号     │
│ - 会话持久化    │ - 导出功能     │ - 错误处理     │ - 打包测试   │
│ - 权限模式      │ - 搜索统计     │ - 回归测试     │ - 发布说明   │
└────────────────┴────────────────┴────────────────┴──────────────┘
```

---

## 二、Phase 1: 基础安全与工具增强

### 2.1 Agent A: 安全基础设施

**目标**: 建立运行时安全监控体系

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| A1 | 创建运行时命令监控模块 | `src/main/security/commandMonitor.ts` | 4h | - |
| A2 | 实现敏感信息检测器 | `src/main/security/sensitiveDetector.ts` | 4h | - |
| A3 | 建立 JSONL 审计日志系统 | `src/main/security/auditLogger.ts` | 4h | - |
| A4 | 集成到 toolExecutor | `src/main/tools/toolExecutor.ts` | 2h | A1-A3 |
| A5 | 添加日志掩码功能 | `src/main/security/logMasker.ts` | 2h | A2 |

#### 技术规格

```typescript
// A1: 命令监控
interface CommandMonitor {
  // 执行前检查（已有）+ 执行中监控（新增）
  preExecute(command: string): ValidationResult;
  monitor(pid: number): Observable<ProcessEvent>;
  postExecute(result: ExecutionResult): AuditEntry;
}

// A2: 敏感信息检测
const SENSITIVE_PATTERNS = {
  apiKey: /(?:api[_-]?key|apikey)[=:]\s*['"]?([a-zA-Z0-9_-]{20,})['"]?/gi,
  awsSecret: /(?:aws[_-]?secret|secret[_-]?key)[=:]\s*['"]?([a-zA-Z0-9/+=]{40})['"]?/gi,
  githubToken: /gh[ps]_[a-zA-Z0-9]{36,}/g,
  // ... 20+ 种模式
};

// A3: 审计日志格式
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
```

#### 验收标准

- [ ] 所有 Bash 命令执行都记录审计日志
- [ ] 敏感信息在日志中自动掩码（显示为 `***REDACTED***`）
- [ ] 支持按时间范围查询审计日志
- [ ] 单元测试覆盖率 > 80%

---

### 2.2 Agent B: 工具实现增强

**目标**: 对齐 claude-code-open 的工具能力

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| B1 | 实现文件读取跟踪器 | `src/main/tools/fileReadTracker.ts` | 3h | - |
| B2 | 添加智能引号规范化 | `src/main/tools/utils/quoteNormalizer.ts` | 2h | - |
| B3 | 实现外部修改检测 | `src/main/tools/utils/externalModificationDetector.ts` | 3h | B1 |
| B4 | 后台任务持久化 | `src/main/tools/backgroundTaskPersistence.ts` | 4h | - |
| B5 | 集成到 edit_file 工具 | `src/main/tools/gen1/edit_file.ts` | 2h | B1-B3 |
| B6 | 增强 Grep 参数支持 | `src/main/tools/gen2/grep.ts` | 3h | - |

#### 技术规格

```typescript
// B1: 文件读取跟踪器
class FileReadTracker {
  private readFiles: Map<string, { mtime: number; readTime: number }> = new Map();

  recordRead(filePath: string, mtime: number): void;
  hasBeenRead(filePath: string): boolean;
  checkExternalModification(filePath: string, currentMtime: number): boolean;
  clear(): void;
}

// B2: 智能引号规范化
const SMART_QUOTE_MAP: Record<string, string> = {
  '\u2018': "'",  // 左单引号 '
  '\u2019': "'",  // 右单引号 '
  '\u201C': '"',  // 左双引号 "
  '\u201D': '"',  // 右双引号 "
  '\u2013': '-',  // en-dash
  '\u2014': '--', // em-dash
};

function normalizeQuotes(str: string): string;
function findMatchingString(content: string, search: string): { index: number; original: string } | null;

// B4: 后台任务持久化
interface BackgroundTask {
  taskId: string;
  command: string;
  startTime: number;
  outputFile: string;  // ~/.code-agent/tasks/{taskId}.log
  status: 'running' | 'completed' | 'failed';
  exitCode?: number;
}
```

#### 验收标准

- [ ] Edit 工具在文件未读取时返回明确错误
- [ ] 从 AI 输出复制的弯引号能正确匹配
- [ ] 文件被外部修改后 Edit 会告警
- [ ] 后台任务在进程重启后可恢复

---

### 2.3 Agent C: System Prompt 重构

**目标**: 建立分层安全框架和详细工具描述

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| C1 | 拆分注入防御为 3 层 | `src/main/generation/prompts/rules/injection/` | 4h | - |
| C2 | 创建详细 Bash 工具描述 | `src/main/generation/prompts/tools/bash.ts` | 3h | - |
| C3 | 创建详细 Edit 工具描述 | `src/main/generation/prompts/tools/edit.ts` | 2h | - |
| C4 | 创建详细 Task 工具描述 | `src/main/generation/prompts/tools/task.ts` | 3h | - |
| C5 | 实现权限等级架构 | `src/main/generation/prompts/rules/permissionLevels.ts` | 3h | - |
| C6 | 添加社工防御规则 | `src/main/generation/prompts/rules/socialEngineering.ts` | 2h | - |
| C7 | 更新 builder.ts 集成 | `src/main/generation/prompts/builder.ts` | 2h | C1-C6 |

#### 目录结构

```
src/main/generation/prompts/
├── base/
│   ├── gen1.ts ... gen8.ts
│   └── index.ts
├── rules/
│   ├── injection/
│   │   ├── core.ts           # 基础指令来源验证
│   │   ├── verification.ts   # 验证响应流程
│   │   ├── meta.ts           # 规则不可修改性
│   │   └── index.ts
│   ├── permissionLevels.ts   # 三层权限架构
│   ├── socialEngineering.ts  # 社工防御
│   ├── gitSafety.ts          # (已有)
│   └── index.ts
├── tools/
│   ├── bash.ts               # 详细 Bash 描述 (~1000 tokens)
│   ├── edit.ts               # 详细 Edit 描述
│   ├── task.ts               # 详细 Task 描述
│   ├── grep.ts               # 详细 Grep 描述
│   └── index.ts
└── builder.ts
```

#### 验收标准

- [ ] 注入防御规则分为 3 个独立文件
- [ ] 每个工具描述包含：参数详解、使用示例、何时不使用
- [ ] 权限架构明确定义 Prohibited/Explicit/Regular 三层
- [ ] Gen3+ 自动包含所有安全规则

---

### 2.4 Agent D: 测试覆盖

**目标**: 为新增功能建立测试基础设施

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| D1 | 安全模块单元测试 | `tests/unit/security/` | 4h | A1-A5 |
| D2 | 工具增强单元测试 | `tests/unit/tools/` | 4h | B1-B6 |
| D3 | Prompt 构建测试 | `tests/unit/prompts/` | 3h | C1-C7 |
| D4 | 集成测试框架搭建 | `tests/integration/setup.ts` | 3h | - |
| D5 | E2E 安全场景测试 | `tests/e2e/security.spec.ts` | 4h | D4 |

#### 测试规范

```typescript
// 安全模块测试示例
describe('SensitiveDetector', () => {
  it('should detect API keys', () => {
    const text = 'api_key=sk-1234567890abcdef';
    expect(detector.detect(text)).toContainEqual({
      type: 'apiKey',
      start: 8,
      end: 30,
      masked: 'api_key=***REDACTED***'
    });
  });

  it('should detect GitHub tokens', () => {
    const text = 'token: ghp_xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx';
    expect(detector.detect(text).length).toBe(1);
  });

  it('should not false positive on normal text', () => {
    const text = 'This is a normal message without secrets';
    expect(detector.detect(text)).toHaveLength(0);
  });
});

// 文件跟踪器测试
describe('FileReadTracker', () => {
  it('should track file reads', () => {
    tracker.recordRead('/path/file.ts', 1234567890);
    expect(tracker.hasBeenRead('/path/file.ts')).toBe(true);
  });

  it('should detect external modifications', () => {
    tracker.recordRead('/path/file.ts', 1234567890);
    expect(tracker.checkExternalModification('/path/file.ts', 1234567900)).toBe(true);
  });
});
```

---

## 三、Phase 2: 高级安全与上下文管理

### 3.1 Agent A: 沙箱隔离系统

**目标**: 实现多平台进程隔离

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| A6 | Linux Bubblewrap 集成 | `src/main/sandbox/bubblewrap.ts` | 8h | - |
| A7 | macOS Seatbelt 集成 | `src/main/sandbox/seatbelt.ts` | 6h | - |
| A8 | 沙箱管理器（自动选择） | `src/main/sandbox/manager.ts` | 4h | A6-A7 |
| A9 | 实现 6 种权限模式 | `src/main/permissions/modes.ts` | 4h | - |
| A10 | 权限策略引擎 | `src/main/permissions/policyEngine.ts` | 6h | A9 |

#### 技术规格

```typescript
// A6: Bubblewrap 配置
interface BubblewrapConfig {
  allowNetwork: boolean;
  readOnlyPaths: string[];
  readWritePaths: string[];
  tmpfs: string[];
  unshareAll: boolean;
  dieWithParent: boolean;
}

async function executeInBubblewrap(
  command: string,
  config: BubblewrapConfig
): Promise<ExecutionResult>;

// A7: Seatbelt 配置
const SEATBELT_PROFILE = `
(version 1)
(deny default)
(allow file-read* (subpath "/usr"))
(allow file-read* (subpath "\${HOME}/projects"))
(allow file-write* (subpath "\${TMPDIR}"))
(allow process-exec)
(deny network*)
`;

// A9: 权限模式
type PermissionMode =
  | 'default'           // 标准提示
  | 'acceptEdits'       // 自动接受编辑
  | 'dontAsk'           // 自动拒绝
  | 'bypassPermissions' // 跳过检查
  | 'plan'              // 规划模式
  | 'delegate';         // 委派模式
```

---

### 3.2 Agent B: 上下文管理系统

**目标**: 实现 Token 估算和增量压缩

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| B7 | Token 精确估算器 | `src/main/context/tokenEstimator.ts` | 4h | - |
| B8 | 增量压缩引擎 | `src/main/context/compressor.ts` | 8h | B7 |
| B9 | 代码块智能保留 | `src/main/context/codePreserver.ts` | 4h | B8 |
| B10 | 会话本地缓存 | `src/main/session/localCache.ts` | 4h | - |
| B11 | AI 摘要生成器 | `src/main/context/summarizer.ts` | 4h | B7 |

#### 技术规格

```typescript
// B7: Token 估算
interface TokenEstimator {
  estimate(text: string): number;
  estimateMessage(message: Message): number;
  estimateConversation(messages: Message[]): number;
}

// 多维度估算
function estimateTokens(text: string): number {
  const hasAsian = /[\u4e00-\u9fa5\u3040-\u30ff\uac00-\ud7af]/.test(text);
  const hasCode = /^```|function\s|class\s|const\s|import\s/.test(text);

  let charsPerToken = 3.5;
  if (hasAsian) charsPerToken = 2.0;
  else if (hasCode) charsPerToken = 3.0;

  const specialChars = (text.match(/[{}[\]().,;:!?<>]/g) || []).length;
  return Math.ceil(text.length / charsPerToken + specialChars * 0.1);
}

// B8: 压缩策略
interface CompressionStrategy {
  type: 'truncate' | 'ai_summary' | 'code_extract' | 'file_ref';
  threshold: number;  // 触发阈值（token 占比）
  targetRatio: number; // 目标压缩比
}

interface CompressionResult {
  originalTokens: number;
  compressedTokens: number;
  savedTokens: number;
  method: string;
  content: string;
}
```

---

### 3.3 Agent C: Hooks 系统重构

**目标**: 实现用户可配置的 Hook 系统

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| C8 | Hook 配置解析器 | `src/main/hooks/configParser.ts` | 3h | - |
| C9 | Bash 脚本执行引擎 | `src/main/hooks/scriptExecutor.ts` | 4h | - |
| C10 | 扩展事件类型（11种） | `src/main/hooks/events.ts` | 4h | - |
| C11 | 多源 Hook 合并 | `src/main/hooks/merger.ts` | 3h | C8 |
| C12 | Prompt-Based Hook | `src/main/hooks/promptHook.ts` | 4h | - |
| C13 | 重构现有 HooksEngine | `src/main/planning/hooksEngine.ts` | 4h | C8-C12 |

#### 配置格式

```json
// .claude/settings.json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "Bash|Write|Edit",
        "hooks": [
          {
            "type": "command",
            "command": "./scripts/security-check.sh",
            "timeout": 5000
          }
        ]
      }
    ],
    "Stop": [
      {
        "hooks": [
          {
            "type": "prompt",
            "prompt": "Evaluate if the task is complete based on: $ARGUMENTS"
          }
        ]
      }
    ]
  }
}
```

#### 事件类型

```typescript
type HookEvent =
  | 'PreToolUse'
  | 'PostToolUse'
  | 'PostToolUseFailure'
  | 'UserPromptSubmit'
  | 'Stop'
  | 'SubagentStop'
  | 'PreCompact'
  | 'Setup'
  | 'SessionStart'
  | 'SessionEnd'
  | 'Notification';
```

---

### 3.4 Agent D: 文档与迁移

**目标**: 更新文档，提供迁移指南

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| D6 | API 文档更新 | `docs/api/` | 4h | All |
| D7 | 迁移指南 | `docs/migration/v0.9-upgrade.md` | 3h | All |
| D8 | CHANGELOG 更新 | `CHANGELOG.md` | 2h | All |
| D9 | CLAUDE.md 更新 | `CLAUDE.md` | 2h | All |
| D10 | 示例代码更新 | `examples/` | 3h | All |

---

## 四、Phase 3: 子代理增强与发布

### 4.1 Agent A: 子代理架构升级

**目标**: 实现自动委派和会话持久化

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| A11 | Agent 描述字段 | `src/main/agent/types.ts` | 2h | - |
| A12 | 自动委派匹配器 | `src/main/agent/autoDelegator.ts` | 6h | A11 |
| A13 | 子代理会话持久化 | `src/main/agent/sessionPersistence.ts` | 4h | - |
| A14 | Resume 命令实现 | `src/main/agent/resume.ts` | 4h | A13 |
| A15 | 子代理权限模式 | `src/main/agent/permissions.ts` | 3h | A9 |

---

### 4.2 Agent B: 会话高级功能

**目标**: 实现 Fork/Resume 和导出功能

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| B12 | 会话 Fork 实现 | `src/main/session/fork.ts` | 6h | B10 |
| B13 | 会话 Resume 实现 | `src/main/session/resume.ts` | 4h | B10 |
| B14 | Markdown 导出 | `src/main/session/exportMarkdown.ts` | 3h | - |
| B15 | 会话搜索功能 | `src/main/session/search.ts` | 4h | B10 |
| B16 | 成本统计报告 | `src/main/session/costReport.ts` | 3h | B7 |

---

### 4.3 Agent C: 集成与优化

**目标**: 性能优化和错误处理完善

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| C14 | 性能 Profiling | - | 4h | All |
| C15 | 内存泄漏检测 | - | 3h | All |
| C16 | 错误边界完善 | `src/main/errors/` | 4h | All |
| C17 | 回归测试 | `tests/regression/` | 4h | All |

---

### 4.4 Agent D: 发布准备

**目标**: 版本号、打包、发布

#### 任务清单

| ID | 任务 | 文件路径 | 工作量 | 依赖 |
|----|------|---------|--------|------|
| D11 | 版本号更新 | `package.json` | 0.5h | All |
| D12 | 构建验证 | - | 2h | All |
| D13 | 打包测试 | - | 2h | D12 |
| D14 | 发布说明 | `docs/releases/v0.9.0.md` | 2h | All |
| D15 | 发布 | - | 1h | D11-D14 |

---

## 五、并行执行协调

### 5.1 依赖关系图

```
Phase 1:
A1 ─┬─► A4
A2 ─┤
A3 ─┘

B1 ─┬─► B5
B2 ─┤
B3 ─┘

C1 ─┬─► C7
C2 ─┤
C3 ─┤
C4 ─┤
C5 ─┤
C6 ─┘

D1 ◄── A1-A5 (依赖)
D2 ◄── B1-B6 (依赖)
D3 ◄── C1-C7 (依赖)

Phase 2:
A6 ─┬─► A8 ─► A10
A7 ─┘
A9 ─────────► A10

B7 ─┬─► B8 ─► B9
    └─► B11

C8 ─┬─► C11 ─► C13
C9 ─┤
C10─┤
C12─┘

Phase 3:
A11 ─► A12
A13 ─► A14
A9  ─► A15

B10 ─► B12 ─► B13
B7  ─► B16
```

### 5.2 关键路径

```
关键路径 1（安全）:
A1 → A4 → A6 → A8 → A10 → A15

关键路径 2（上下文）:
B7 → B8 → B9 → B12 → B13

关键路径 3（Hooks）:
C8 → C11 → C13

交付里程碑:
Week 2: Phase 1 完成 → 可发布 v0.8.30 (安全基础)
Week 4: Phase 2 完成 → 可发布 v0.9.0-beta (上下文+Hooks)
Week 6: Phase 3 完成 → 可发布 v0.9.0 (完整对标)
```

### 5.3 Agent 分工原则

```
Agent A: 安全专家
- 专注: 命令监控、沙箱、权限、审计
- 技能: 系统编程、安全机制、进程隔离

Agent B: 工具专家
- 专注: 文件操作、上下文管理、会话功能
- 技能: 算法优化、Token 估算、压缩策略

Agent C: 架构专家
- 专注: Prompt 重构、Hooks 系统、子代理
- 技能: 系统设计、API 设计、配置管理

Agent D: 质量专家
- 专注: 测试、文档、发布
- 技能: 测试设计、技术写作、CI/CD
```

### 5.4 协调机制

```yaml
# 每日同步
- 时间: 每天开始时
- 内容:
  - 昨日完成
  - 今日计划
  - 阻塞项

# 共享资源
- Git 分支策略:
  - main: 稳定版本
  - develop: 集成分支
  - feature/security-*: Agent A
  - feature/tools-*: Agent B
  - feature/prompts-*: Agent C
  - feature/tests-*: Agent D

# 代码审查
- 每个 PR 需要至少一个其他 Agent 审查
- 跨模块修改需要架构专家 (Agent C) 参与

# 冲突解决
- 文件冲突: 先提交者优先，后提交者 rebase
- 接口冲突: 在 shared/types 中定义，所有 Agent 遵循
```

---

## 六、风险与缓解

### 6.1 技术风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| Bubblewrap 在某些 Linux 发行版不可用 | 中 | 高 | 实现优雅降级，记录警告 |
| Seatbelt 在新 macOS 版本变化 | 低 | 中 | 版本检测 + 动态配置 |
| Token 估算不准确 | 中 | 中 | 使用真实 API 用量校准 |
| 压缩丢失关键信息 | 中 | 高 | 保留原始内容备份 |

### 6.2 进度风险

| 风险 | 概率 | 影响 | 缓解措施 |
|------|------|------|---------|
| 任务估算不准确 | 高 | 中 | 每周重新评估，调整计划 |
| Agent 阻塞等待依赖 | 中 | 中 | 提前识别依赖，调整顺序 |
| 集成问题 | 中 | 高 | 频繁集成，每天 merge |

---

## 七、验收标准

### 7.1 Phase 1 验收

- [ ] 所有 Bash 命令有审计日志
- [ ] 敏感信息自动掩码
- [ ] Edit 工具检测外部修改
- [ ] 智能引号正确处理
- [ ] System Prompt 分层完成
- [ ] 测试覆盖率 > 70%

### 7.2 Phase 2 验收

- [ ] Linux/macOS 沙箱可用
- [ ] Token 估算误差 < 10%
- [ ] 上下文压缩节省 > 30% token
- [ ] Hooks 支持外部脚本
- [ ] 文档完整

### 7.3 Phase 3 验收

- [ ] 子代理自动委派工作
- [ ] 会话 Fork/Resume 可用
- [ ] 成本统计准确
- [ ] 性能无明显退化
- [ ] 所有测试通过
- [ ] 打包成功

---

## 八、附录

### 8.1 参考资源

- [claude-code-open 源码](https://github.com/lookfree/claude-code-open)
- [claude-code-system-prompts](https://github.com/Piebald-AI/claude-code-system-prompts)
- [本地克隆](/tmp/claude-code-open)

### 8.2 相关文档

- [架构概览](../architecture/overview.md)
- [工具系统](../architecture/tool-system.md)
- [Agent 核心](../architecture/agent-core.md)

### 8.3 变更日志

| 日期 | 版本 | 变更 |
|------|------|------|
| 2026-01-22 | 1.0 | 初始版本 |
