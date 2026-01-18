# Claude Code Prompt 借鉴升级 - 待办清单

> 基于 `/Users/linchen/.claude/plans/graceful-toasting-eich.md` 规划文件
>
> 上次更新：2025-01-18

---

## 已完成 ✅

| 功能 | 优先级 | 完成时间 |
|------|--------|---------|
| 专业客观性指导 | P0 | 2025-01-18 |
| Plan Mode 工具实现 (enter_plan_mode, exit_plan_mode) | P0 | 2025-01-18 |
| Git 安全协议 | P1 | 2025-01-18 |
| 并行工具调用指导 | P2 | 2025-01-18 |
| 代码引用格式 | P2 | 2025-01-18 |
| 新规则模块文件 (6个) | - | 2025-01-18 |
| AgentLoop Plan Mode 状态管理 | - | 2025-01-18 |
| 规则注入到所有 8 个代际 | - | 2025-01-18 |
| TypeScript 类型检查通过 | - | 2025-01-18 |
| 构建验证通过 | - | 2025-01-18 |

### 已创建的文件

```
src/main/generation/prompts/rules/
├── professionalObjectivity.ts   # 专业客观性
├── gitSafety.ts                 # Git 安全协议
├── parallelTools.ts             # 并行工具调用
├── codeReference.ts             # 代码引用格式
├── planMode.ts                  # Plan Mode 指导
└── index.ts                     # 导出

src/main/tools/gen3/
├── enterPlanMode.ts             # Plan Mode 入口工具
└── exitPlanMode.ts              # Plan Mode 出口工具
```

### 已修改的文件

- `src/main/tools/ToolRegistry.ts` - 扩展 ToolContext，注册新工具
- `src/main/tools/ToolExecutor.ts` - 传递 Plan Mode 回调
- `src/main/agent/AgentLoop.ts` - 添加 planModeActive 状态管理
- `src/main/generation/GenerationManager.ts` - 导入并注入新规则

---

## 待完成 ❌

### 1. 工具描述增强 (P1)

**目标：** 参考 Claude Code v2.0 的工具描述格式，增强现有工具的 description

**需要更新的文件：**

- [ ] `src/main/tools/gen1/bash.ts`
- [ ] `src/main/tools/gen1/readFile.ts`
- [ ] `src/main/tools/gen1/writeFile.ts`
- [ ] `src/main/tools/gen1/editFile.ts`
- [ ] `src/main/tools/gen2/glob.ts`
- [ ] `src/main/tools/gen2/grep.ts`

**增强内容：**
- 使用场景说明
- 参数详细描述
- 禁止事项清单
- 示例用法

**参考格式（bash 工具示例）：**

```typescript
description: `Execute shell commands in a persistent shell session.

IMPORTANT: Use for terminal operations (git, npm, docker) only.
DO NOT use for file operations - use specialized tools instead:
- File search: Use glob (NOT find or ls)
- Content search: Use grep (NOT grep or rg)
- Read files: Use read_file (NOT cat/head/tail)
- Edit files: Use edit_file (NOT sed/awk)

Usage notes:
- Always quote paths with spaces: cd "/path/with spaces"
- Use absolute paths, avoid cd when possible
- Chain dependent commands with &&
- Independent commands can be called in parallel
`
```

---

### 2. 完整模块化重构 (P2)

**目标：** 将 GenerationManager.ts (1140+ 行) 拆分为模块化结构

**当前状态：** 只创建了 `prompts/rules/` 目录

**目标结构：**

```
src/main/generation/
├── GenerationManager.ts          # 精简为 ~150 行
├── metadata.ts                   # GENERATION_DEFINITIONS
├── prompts/
│   ├── base/
│   │   ├── gen1.ts              # Gen1 基础提示词
│   │   ├── gen2.ts              # Gen2 基础提示词
│   │   ├── gen3.ts              # Gen3 基础提示词
│   │   ├── gen4.ts              # Gen4 基础提示词
│   │   ├── gen5.ts              # Gen5 基础提示词
│   │   ├── gen6.ts              # Gen6 基础提示词
│   │   ├── gen7.ts              # Gen7 基础提示词
│   │   ├── gen8.ts              # Gen8 基础提示词
│   │   └── index.ts             # 导出所有基础提示词
│   ├── rules/                   # ✅ 已完成
│   │   ├── outputFormat.ts      # 需新建：从 GenerationManager 提取
│   │   ├── htmlGeneration.ts    # 需新建：从 GenerationManager 提取
│   │   └── ...                  # 已有 6 个新规则
│   └── builder.ts               # 提示词组装器
```

**待创建文件清单：**

- [ ] `src/main/generation/metadata.ts`
- [ ] `src/main/generation/prompts/base/gen1.ts`
- [ ] `src/main/generation/prompts/base/gen2.ts`
- [ ] `src/main/generation/prompts/base/gen3.ts`
- [ ] `src/main/generation/prompts/base/gen4.ts`
- [ ] `src/main/generation/prompts/base/gen5.ts`
- [ ] `src/main/generation/prompts/base/gen6.ts`
- [ ] `src/main/generation/prompts/base/gen7.ts`
- [ ] `src/main/generation/prompts/base/gen8.ts`
- [ ] `src/main/generation/prompts/base/index.ts`
- [ ] `src/main/generation/prompts/rules/outputFormat.ts`
- [ ] `src/main/generation/prompts/rules/htmlGeneration.ts`
- [ ] `src/main/generation/prompts/builder.ts`

---

### 3. 注入防护 (P3 - 可选)

**目标：** 借鉴 Claude Code v2.0 的 prompt injection 防护规则

**状态：** 计划中标记为"桌面应用风险低"，可根据需要决定是否实施

**参考：** `docs/prompts/claude-code-v2.0-full.txt` 中的 injection defense 部分

---

### 4. 文档与测试 (P3)

- [ ] 更新 `docs/architecture/agent-core.md` - 添加 Plan Mode 说明
- [ ] 添加 Plan Mode 工具的单元测试
- [ ] 导出升级后的提示词，与 Claude Code v2.0 对比覆盖率

---

## 验证清单

完成上述任务后，运行以下验证：

```bash
# 1. 类型检查
npm run typecheck

# 2. 构建
npm run build

# 3. 功能测试
npm run dev
```

**功能测试场景：**

1. **Plan Mode**：Gen3 会话中请求"帮我实现一个新功能"，验证自动进入规划模式
2. **专业客观性**：问"React 和 Vue 哪个更好？"，验证客观分析
3. **Git 安全**：尝试 `git push --force`，验证警告提示
4. **代码引用**：问"某函数在哪里定义？"，验证 `file:line` 格式输出
5. **并行调用**：请求同时搜索多个文件，验证并行执行

---

## 相关文件

- 规划文件：`/Users/linchen/.claude/plans/graceful-toasting-eich.md`
- Claude Code v2.0 参考：`docs/prompts/claude-code-v2.0-full.txt`
- Claude Code 工具定义：`docs/prompts/claude-code-tools.json`
- 对比分析文档：`docs/claude-code-prompt-comparison.md`
