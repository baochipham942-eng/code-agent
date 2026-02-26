# RFC-005: Codex CLI 对标优化方案

> 状态: Draft | 日期: 2026-02-26 | 作者: Claude + Lin

## 背景

对比 OpenAI Codex CLI（Rust 重写后）与 Code Agent v0.16.37+v32 的能力差距，
识别出以下可借鉴的设计模式和需要补齐的能力。

### 修正说明

原始分析中"MCP Client 缺失"是误判 — Code Agent 已有完整的 MCP Client
（`mcpClient.ts`，支持 stdio/SSE/HTTP/in-process 四种传输），以及 6 个 MCP 工具。
实际的差距在于 **MCP Server 能力**（Code Agent 自身作为 MCP Server 暴露给外部）
和 **MCP Schema 清洗**。

---

## P0: Bash 安全命令白名单 + 智能审批

### 问题

当前 bash 执行链路：
```
command → CommandMonitor.preExecute() → isDangerousCommand() → requestPermission()
```

缺陷：
1. 只检测「危险命令」，没有「安全命令」白名单 — 所有命令都需要 UI 审批
2. 审批只缓存到 session 级（`ConfirmationGate.sessionApprovals`），不持久化
3. 无命令前缀规则学习（用户批准 `npm install` 后，`npm install xxx` 仍需再次批准）

### Codex 设计

```rust
// 1. 安全命令白名单 — 自动跳过审批
is_known_safe_command("cat", &args) → true
is_known_safe_command("find", &["-exec", ...]) → false（有副作用）

// 2. prefix_rule 学习 — 用户批准后生成持久化规则
user approves "npm install" → { pattern: ["npm", "install"], decision: "allow" }
→ 后续 "npm install xxx" 自动跳过

// 3. 三级决策
enum Decision { Allow, Prompt, Forbidden }
```

### 实现方案

#### 文件: `src/main/security/commandSafety.ts`（新建）

```typescript
// 无条件安全的命令 — 永远不修改文件系统或网络
const UNCONDITIONALLY_SAFE: Set<string> = new Set([
  'cat', 'head', 'tail', 'wc', 'sort', 'uniq', 'cut', 'paste',
  'echo', 'printf', 'expr', 'true', 'false', 'test',
  'ls', 'pwd', 'which', 'whoami', 'id', 'uname', 'hostname',
  'date', 'cal', 'env', 'printenv',
  'grep', 'egrep', 'fgrep', 'rg', 'ag',
  'diff', 'comm', 'tr', 'rev', 'seq', 'nl', 'tee',
  'file', 'stat', 'du', 'df',
  'basename', 'dirname', 'realpath', 'readlink',
  'jq', 'yq', 'xargs',  // 纯数据处理
]);

// 条件安全的命令 — 特定参数组合下安全
const CONDITIONALLY_SAFE: Record<string, (args: string[]) => boolean> = {
  'find': (args) => !args.some(a =>
    ['-exec', '-execdir', '-delete', '-fls', '-fprint'].includes(a)
  ),
  'git': (args) => {
    const subcommand = args[0];
    return ['status', 'log', 'diff', 'show', 'branch', 'tag',
            'remote', 'stash list', 'describe'].includes(subcommand)
      && !args.includes('-c'); // -c 可执行任意外部命令
  },
  'npm': (args) => ['list', 'ls', 'view', 'info', 'outdated',
                     'audit', 'why', 'explain'].includes(args[0]),
  'python3': (args) => args[0] === '-c' && args.length === 2,
  'node': (args) => args[0] === '-e' && args.length === 2,
  'sed': (args) => args.includes('-n') && !args.some(a => a.includes('w ')),
  'awk': (args) => !args.some(a => a.includes('system(') || a.includes('> ')),
};

export function isKnownSafeCommand(command: string): boolean {
  // 1. 解析 bash 复合命令（&&, ||, ;, |）
  // 2. 对每个子命令检查安全性
  // 3. 拒绝含重定向(>)、子shell(())、不安全命令的组合
}
```

#### 文件: `src/main/security/execPolicy.ts`（新建）

```typescript
interface PrefixRule {
  pattern: string[];      // ["npm", "install"]
  decision: 'allow' | 'prompt' | 'forbidden';
  createdAt: number;
  source: 'user' | 'builtin';
}

export class ExecPolicyStore {
  private rules: PrefixRule[] = [];
  private filePath: string;  // .code-agent/exec-policy.json

  /** 匹配命令 → 返回 decision 或 null（未匹配） */
  match(command: string): 'allow' | 'prompt' | 'forbidden' | null;

  /** 用户批准后追加规则 */
  addRule(pattern: string[], decision: 'allow'): void;

  /** 持久化到磁盘 */
  save(): Promise<void>;
}
```

#### 改动: `src/main/tools/toolExecutor.ts`

```typescript
// 在 execute() 方法中，permission check 之前插入：

// P0: 安全命令白名单 — 已知安全命令跳过审批
if (toolName === 'bash' && params.command) {
  const cmd = params.command as string;

  // 1. 检查 exec policy 持久化规则
  const policyDecision = execPolicyStore.match(cmd);
  if (policyDecision === 'allow') {
    // 跳过审批
  } else if (policyDecision === 'forbidden') {
    return { success: false, error: 'Blocked by exec policy' };
  }

  // 2. 检查安全命令白名单
  if (isKnownSafeCommand(cmd)) {
    // 跳过审批
  }
}
```

### 验证

- [x] 安全白名单：`ls`, `git status`, `cat file.txt` 自动执行
- [x] 条件安全：`find . -name "*.ts"` 安全，`find . -exec rm {} \;` 需确认
- [x] prefix_rule：批准 `npm install` 后，`npm install lodash` 自动执行
- [x] 危险命令：`rm -rf /` 仍然被阻断

### 工作量估算

| 文件 | 操作 | 行数 |
|------|------|------|
| `commandSafety.ts` | 新建 | ~200 |
| `execPolicy.ts` | 新建 | ~150 |
| `toolExecutor.ts` | 改动 | ~30 |
| `commandSafety.test.ts` | 新建 | ~150 |
| **合计** | | ~530 |

---

## P0-B: 输出中间截断（保留首尾）

### 问题

当前 bash 输出截断：
```typescript
// bash.ts:294
output = output.substring(0, BASH.MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
```

只保留开头，丢弃结尾。但模型通常需要：
- **开头**：命令输出的结构信息、错误消息
- **结尾**：执行总结、退出状态、最终结果

### Codex 设计

```rust
fn truncate_with_byte_estimate(s: &str, budget: usize) -> String {
    let (left_budget, right_budget) = (budget / 2, budget / 2);
    // "前半部分...\n[N chars truncated]\n...后半部分"
}
```

### 实现方案

#### 文件: `src/main/utils/truncate.ts`（新建）

```typescript
/**
 * 中间截断策略 — 保留首尾，截断中间
 *
 * @param text - 原始文本
 * @param maxLength - 最大长度
 * @param headRatio - 头部占比（默认 0.5）
 * @returns 截断后的文本
 */
export function truncateMiddle(
  text: string,
  maxLength: number,
  headRatio = 0.5
): string {
  if (text.length <= maxLength) return text;

  const headBudget = Math.floor(maxLength * headRatio);
  const tailBudget = maxLength - headBudget;
  const removed = text.length - headBudget - tailBudget;

  const head = text.substring(0, headBudget);
  const tail = text.substring(text.length - tailBudget);

  // 在行边界截断，避免截断一行的中间
  const headEnd = head.lastIndexOf('\n');
  const tailStart = tail.indexOf('\n');

  const cleanHead = headEnd > 0 ? head.substring(0, headEnd) : head;
  const cleanTail = tailStart > 0 ? tail.substring(tailStart + 1) : tail;

  return `${cleanHead}\n\n... [${removed} characters truncated] ...\n\n${cleanTail}`;
}
```

#### 改动: `src/main/tools/shell/bash.ts`

```diff
- output = output.substring(0, BASH.MAX_OUTPUT_LENGTH) + '\n... (output truncated)';
+ output = truncateMiddle(output, BASH.MAX_OUTPUT_LENGTH);
```

### 工作量估算

| 文件 | 操作 | 行数 |
|------|------|------|
| `truncate.ts` | 新建 | ~50 |
| `bash.ts` | 改动 | ~5 |
| `truncate.test.ts` | 新建 | ~40 |
| **合计** | | ~95 |

---

## P1-A: Skill 隐式激活

### 问题

当前 Skill 只能通过 `skill({ command: "name" })` 显式调用。
模型需要先知道有哪些 skill，再决定调用哪个。

Codex 的 Skill 支持隐式激活 — 根据任务描述自动匹配 skill 元数据。

### 实现方案

#### 改动: `src/main/services/skills/skillDiscovery.ts`

```typescript
interface SkillMetadata {
  name: string;
  description: string;
  keywords: string[];           // 新增: 关键词匹配
  triggerPatterns?: RegExp[];   // 新增: 正则触发模式
  allowImplicitInvocation?: boolean; // 默认 true
}

/**
 * 根据用户消息自动匹配 skill
 * 返回按相关性排序的 skill 列表（最多 3 个）
 */
function matchSkillsImplicitly(userMessage: string): ParsedSkill[] {
  const skills = discoveryService.getAllSkills()
    .filter(s => s.allowImplicitInvocation !== false);

  return skills
    .map(skill => ({
      skill,
      score: calculateRelevance(skill, userMessage),
    }))
    .filter(({ score }) => score > 0.6)
    .sort((a, b) => b.score - a.score)
    .slice(0, 3)
    .map(({ skill }) => skill);
}
```

#### 改动: `src/main/agent/agentLoop.ts`

在构建 system prompt 时，检查是否有隐式匹配的 skill：

```typescript
// 在 prepareMessages 或 buildSystemPrompt 中
const implicitSkills = matchSkillsImplicitly(lastUserMessage);
if (implicitSkills.length > 0) {
  // 将 skill 的 promptContent 注入到 system prompt
  systemPrompt += `\n\n## Relevant Skills\n`;
  for (const skill of implicitSkills) {
    systemPrompt += `### ${skill.name}\n${skill.description}\n`;
    systemPrompt += `Activate with: skill({ command: "${skill.name}" })\n`;
  }
}
```

### 工作量估算

| 文件 | 操作 | 行数 |
|------|------|------|
| `skillDiscovery.ts` | 改动 | ~80 |
| `agentLoop.ts` | 改动 | ~20 |
| `SKILL.md 格式扩展` | 改动 | ~10 |
| **合计** | | ~110 |

---

## P1-B: 会话 Fork

### 问题

当前无法回到对话历史的某个节点重新尝试。Code Agent 已有 `forkSessionTool`
（memory 目录），但功能是 fork 到新 session，不是从历史点 fork。

### Codex 设计

```bash
codex fork          # 交互式选择历史点
codex resume <id>   # 从 fork 点继续
```

### 实现方案

#### 改动: `src/main/agent/sessionPersistence.ts`

```typescript
/**
 * Fork 会话 — 从指定消息 ID 开始创建新分支
 *
 * @param sessionId - 原始会话 ID
 * @param forkAtMessageId - fork 点消息 ID（包含该消息及之前的所有内容）
 * @returns 新会话 ID
 */
export async function forkSession(
  sessionId: string,
  forkAtMessageId: string
): Promise<string> {
  // 1. 读取原始会话的消息历史
  const messages = await loadSessionMessages(sessionId);

  // 2. 截取到 fork 点
  const forkIndex = messages.findIndex(m => m.id === forkAtMessageId);
  if (forkIndex === -1) throw new Error(`Message ${forkAtMessageId} not found`);
  const forkedMessages = messages.slice(0, forkIndex + 1);

  // 3. 创建新会话
  const newSessionId = `${sessionId}_fork_${Date.now()}`;
  await saveSessionMessages(newSessionId, forkedMessages);

  // 4. 记录 fork 关系
  await recordForkRelation(sessionId, newSessionId, forkAtMessageId);

  return newSessionId;
}
```

#### UI: `src/renderer/components/SessionHistory/ForkButton.tsx`

在消息气泡上添加 "从此处 Fork" 按钮，点击后创建新分支并切换。

### 工作量估算

| 文件 | 操作 | 行数 |
|------|------|------|
| `sessionPersistence.ts` | 改动 | ~80 |
| `ForkButton.tsx` | 新建 | ~60 |
| IPC handler | 新建 | ~20 |
| **合计** | | ~160 |

---

## P1-C: 代码审查 /review

### 问题

Code Agent 没有内置的代码审查命令。用户需要手动描述"帮我审查最近的改动"。

### Codex 设计

```bash
/review                    # 审查当前分支 vs base
/review --commit abc123    # 审查特定 commit
/review --focus security   # 指定审查关注点
```

### 实现方案

#### 文件: `.code-agent/skills/code-review/SKILL.md`（新建）

```markdown
---
name: code-review
description: 代码审查 — 分析 git diff 并提供结构化反馈
keywords: [review, 审查, PR, diff, code review]
allowed-tools: [bash, read_file, glob, grep]
execution-context: inline
---

## Instructions

You are performing a code review. Follow these steps:

1. **Gather context**: Run `git diff` (or `git diff <base>...HEAD`) to get changes
2. **Analyze each file**: For significant changes, read the full file for context
3. **Provide structured feedback**:
   - 🔴 Critical: Security vulnerabilities, data loss risks, logic errors
   - 🟡 Warning: Performance issues, missing error handling, edge cases
   - 🟢 Suggestion: Style improvements, refactoring opportunities
   - ✅ Good: Well-written code worth noting

$ARGUMENTS
```

这个方案利用已有的 Skill 系统，零新代码实现 /review。

### 工作量估算

| 文件 | 操作 | 行数 |
|------|------|------|
| `SKILL.md` | 新建 | ~40 |
| **合计** | | ~40 |

---

## Function Call 借鉴清单

基于 Codex CLI 工具调用架构分析，以下 10 个设计模式值得借鉴：

### 已有（Code Agent 已实现）

| 模式 | Codex | Code Agent | 状态 |
|------|-------|-----------|------|
| DAG 并行调度 | RwLock 读写锁 | dagScheduler.ts | ✅ 已有（方式不同但等效） |
| MCP Client | stdio/HTTP | stdio/SSE/HTTP/in-process | ✅ 已有（更强） |
| 审批缓存 | ApprovalStore | ConfirmationGate.sessionApprovals | ✅ 已有（缺持久化） |
| 工具混淆检测 | 无 | bash.ts:235 toolConfusionMatch | ✅ 已有（Code Agent 更强） |
| Cancellation | CancellationToken | AbortController | ✅ 已有 |

### 需要借鉴

| # | 模式 | 说明 | 优先级 | 实现方案 |
|---|------|------|--------|---------|
| 1 | **安全命令白名单** | 自动跳过已知安全命令的审批 | P0 | 见上文 commandSafety.ts |
| 2 | **中间截断** | 保留首尾，截断中间 | P0 | 见上文 truncate.ts |
| 3 | **prefix_rule 持久化** | 审批决策生成持久化规则 | P0 | 见上文 execPolicy.ts |
| 4 | **per-tool 并行声明** | 工具自声明是否支持并行 | P2 | 在 Tool 接口加 `supportsParallel: boolean` |
| 5 | **Freeform 工具格式** | 避免 JSON 转义地狱 | P3 | 对 edit_file 的 code 参数用 raw string |
| 6 | **Indentation-aware read** | 按代码缩进结构读取 | P2 | read_file 加 `mode: 'indentation'` |
| 7 | **MCP Schema 清洗** | 修复外部 MCP 工具的 schema 缺陷 | P1 | mcpClient.ts 加 sanitizeJsonSchema() |
| 8 | **MCP Server 模式** | Code Agent 自身暴露为 MCP Server | P2 | mcpServer.ts 已有基础 |
| 9 | **exec_command + write_stdin** | 长运行交互式进程 session 化 | P3 | PTY 系统已有类似能力 |
| 10 | **Shell 环境变量过滤** | 自动过滤 SECRET/KEY/TOKEN | P1 | sanitizeEnv.ts 已有，需加自动过滤 |

### 深度分析: #1 安全命令白名单

这是 **投入产出比最高** 的优化。原因：

1. **减少用户点击**：`git status`, `ls`, `cat` 这类读取命令占工具调用的 ~40%，
   每次都弹审批框严重影响体验
2. **减少 round trip**：用户不在时（如后台运行），安全命令可以自动链式执行
3. **实现成本低**：~200 行代码，纯静态分析，无运行时风险

Codex 的 `is_known_safe_command` 还支持解析 `bash -lc "cmd"` 包裹和 `&&`/`||`/`;`/`|` 复合命令。这个级别的解析在 TypeScript 中也不难实现。

### 深度分析: #7 MCP Schema 清洗

Code Agent 的 mcpClient.ts 已经很完善，但缺少对外部 MCP 服务器返回的 schema 的清洗。
Codex 的 `sanitize_json_schema()` 做了以下修复：

```typescript
function sanitizeJsonSchema(schema: any): any {
  // 1. 确保每个对象有 type 字段
  if (schema.properties && !schema.type) schema.type = 'object';
  if (schema.items && !schema.type) schema.type = 'array';

  // 2. 确保 object 有 properties
  if (schema.type === 'object' && !schema.properties) {
    schema.properties = {};
  }

  // 3. 确保 array 有 items
  if (schema.type === 'array' && !schema.items) {
    schema.items = { type: 'string' };
  }

  // 4. 递归清洗子节点
  if (schema.properties) {
    for (const key of Object.keys(schema.properties)) {
      schema.properties[key] = sanitizeJsonSchema(schema.properties[key]);
    }
  }

  return schema;
}
```

这对于从社区获取的 MCP 服务器尤其重要，因为很多服务器的 schema 不完整。

---

## 实施路线图

```
Week 1 (P0):
├── commandSafety.ts + 测试     [2天]
├── execPolicy.ts + 持久化      [1天]
├── truncateMiddle + 集成       [0.5天]
└── toolExecutor.ts 集成        [0.5天]

Week 2 (P1):
├── Skill 隐式激活              [1天]
├── code-review SKILL.md        [0.5天]
├── MCP Schema 清洗             [0.5天]
├── 环境变量自动过滤增强         [0.5天]
└── 会话 Fork (后端)            [1天]

Week 3 (P1 续):
├── 会话 Fork (前端 UI)         [1天]
├── 集成测试 + 评测             [1天]
└── 文档更新                    [0.5天]
```

### 预期收益

| 优化项 | 指标 | 预期改善 |
|--------|------|---------|
| 安全命令白名单 | 用户审批点击次数 | -40% |
| prefix_rule | 重复审批次数 | -60% |
| 中间截断 | 模型理解截断输出能力 | 定性改善（首尾可见） |
| Skill 隐式激活 | Skill 使用率 | +200%（从需要知道 → 自动匹配） |
| 会话 Fork | 用户回退重试成本 | 从"重新开始" → "从某点 fork" |
| 代码审查 | /review 可用性 | 0 → 1（新能力） |

---

## 参考资料

- [Codex CLI 源码](https://github.com/openai/codex) — `codex-rs/core/src/tools/`
- [Codex Security Model](https://developers.openai.com/codex/security/)
- [Codex Agent Skills](https://developers.openai.com/codex/skills)
- [Code Agent Architecture](../docs/ARCHITECTURE.md)
