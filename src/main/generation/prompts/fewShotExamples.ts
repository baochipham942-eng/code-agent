// ============================================================================
// Few-Shot Examples - 示例库
// ============================================================================
// 为不同类型的任务提供高质量的示例
// 帮助模型理解期望的行为模式
// ============================================================================

/**
 * 示例类型
 */
export type ExampleType =
  | 'parallel_dispatch'
  | 'subagent_delegation'
  | 'error_recovery'
  | 'plan_mode'
  | 'code_review'
  | 'git_commit'
  | 'file_edit';

/**
 * Few-shot 示例定义
 */
export interface FewShotExample {
  type: ExampleType;
  title: string;
  userPrompt: string;
  assistantResponse: string;
  tokens: number;
  tags: string[];
}

/**
 * 估算 token 数量
 */
function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

// ----------------------------------------------------------------------------
// 示例定义
// ----------------------------------------------------------------------------

export const FEW_SHOT_EXAMPLES: FewShotExample[] = [
  // ----------------------------------------------------------------------------
  // 并行派发示例
  // ----------------------------------------------------------------------------
  {
    type: 'parallel_dispatch',
    title: '多维度安全审计',
    userPrompt: '对项目进行全面的安全审计',
    assistantResponse: `我将从多个维度对项目进行安全审计，并行派发专门的子代理：

<tool_calls>
task(subagent_type="code-review", prompt="安全审计 - 认证授权：检查身份验证、访问控制、会话管理等")
task(subagent_type="code-review", prompt="安全审计 - 输入验证：检查 SQL 注入、XSS、命令注入等")
task(subagent_type="code-review", prompt="安全审计 - 数据安全：检查敏感数据处理、加密、存储安全")
task(subagent_type="code-review", prompt="安全审计 - 依赖安全：检查第三方依赖漏洞")
</tool_calls>`,
    tokens: 200,
    tags: ['audit', 'security', 'parallel'],
  },
  {
    type: 'parallel_dispatch',
    title: '代码质量多维度分析',
    userPrompt: '分析这个模块的代码质量',
    assistantResponse: `我将从多个维度分析代码质量：

<tool_calls>
task(subagent_type="code-review", prompt="代码质量分析 - 可维护性：检查代码结构、命名规范、注释质量")
task(subagent_type="code-review", prompt="代码质量分析 - 性能：检查算法复杂度、内存使用、潜在瓶颈")
task(subagent_type="code-review", prompt="代码质量分析 - 测试覆盖：检查测试完整性、边界条件处理")
</tool_calls>`,
    tokens: 180,
    tags: ['quality', 'parallel'],
  },

  // ----------------------------------------------------------------------------
  // 子代理委派示例
  // ----------------------------------------------------------------------------
  {
    type: 'subagent_delegation',
    title: '代码探索委派',
    userPrompt: '帮我找到所有处理用户认证的代码',
    assistantResponse: `这是一个需要广泛探索的任务，我将委派给专门的 explore 子代理：

<tool_calls>
task(subagent_type="explore", prompt="找到所有处理用户认证的代码：
1. 搜索 auth、login、authenticate 相关的文件和函数
2. 找到认证中间件和守卫
3. 识别 JWT/session 处理逻辑
4. 返回完整的文件路径和关键代码位置")
</tool_calls>`,
    tokens: 150,
    tags: ['explore', 'delegation'],
  },
  {
    type: 'subagent_delegation',
    title: '架构分析委派',
    userPrompt: '分析这个项目的整体架构',
    assistantResponse: `架构分析需要全面的代码库探索，我将委派给 plan 子代理：

<tool_calls>
task(subagent_type="plan", prompt="分析项目整体架构：
1. 识别项目的分层结构（表示层、业务层、数据层）
2. 分析主要模块及其职责
3. 识别核心数据流和控制流
4. 找出关键的依赖关系
5. 生成架构概览文档")
</tool_calls>`,
    tokens: 160,
    tags: ['architecture', 'plan', 'delegation'],
  },

  // ----------------------------------------------------------------------------
  // 错误恢复示例
  // ----------------------------------------------------------------------------
  {
    type: 'error_recovery',
    title: '工具失败后的恢复',
    userPrompt: '（接上文，edit_file 失败）',
    assistantResponse: `edit_file 失败了，我来分析原因并尝试恢复：

1. **错误分析**：文件内容与预期不符，可能是文件在其他地方被修改过

2. **恢复策略**：
   - 首先重新读取文件获取最新内容
   - 然后基于最新内容重新构建编辑

<tool_calls>
read_file(path="/src/components/Auth.tsx")
</tool_calls>

读取最新内容后，我将重新执行编辑操作。`,
    tokens: 140,
    tags: ['error', 'recovery', 'edit'],
  },

  // ----------------------------------------------------------------------------
  // Plan Mode 示例
  // ----------------------------------------------------------------------------
  {
    type: 'plan_mode',
    title: 'Plan Mode 执行流程',
    userPrompt: '帮我实现一个新的用户管理功能',
    assistantResponse: `这是一个需要规划的复杂任务，我将进入 Plan Mode：

**Phase 1: 探索现有代码**
<tool_calls>
task(subagent_type="explore", prompt="探索用户相关的现有代码：用户模型、用户服务、用户控制器")
task(subagent_type="explore", prompt="探索数据库 schema 和迁移文件")
</tool_calls>

**Phase 2: 设计方案**
（等待探索结果后）派发 plan 子代理设计实现方案

**Phase 3: 用户确认**
使用 ask_user_question 确认关键设计决策

**Phase 4: 生成计划**
整合所有信息生成详细实施计划

**Phase 5: 退出 Plan Mode**
调用 exit_plan_mode 提交计划`,
    tokens: 200,
    tags: ['plan', 'complex'],
  },

  // ----------------------------------------------------------------------------
  // Git 提交示例
  // ----------------------------------------------------------------------------
  {
    type: 'git_commit',
    title: '规范的 Git 提交',
    userPrompt: '提交刚才的修改',
    assistantResponse: `我来提交刚才的修改：

<tool_calls>
bash(command="git status")
</tool_calls>

确认变更文件后：

<tool_calls>
bash(command="git add src/components/Auth.tsx src/services/authService.ts")
bash(command="git commit -m 'feat(auth): 添加用户登录功能\\n\\n- 实现登录表单组件\\n- 添加 JWT token 验证服务\\n- 集成会话管理'")
</tool_calls>

注意：我不会自动 push，除非您明确要求。`,
    tokens: 150,
    tags: ['git', 'commit'],
  },

  // ----------------------------------------------------------------------------
  // 文件编辑示例
  // ----------------------------------------------------------------------------
  {
    type: 'file_edit',
    title: '使用 edit_file 修改代码',
    userPrompt: '在 AuthService 中添加 logout 方法',
    assistantResponse: `我先读取文件确认当前内容：

<tool_calls>
read_file(path="/src/services/authService.ts")
</tool_calls>

然后使用 edit_file 添加 logout 方法（只修改需要的部分）：

<tool_calls>
edit_file(
  path="/src/services/authService.ts",
  old_string="  async login(credentials: LoginCredentials): Promise<User> {",
  new_string="  async logout(): Promise<void> {
    localStorage.removeItem('token');
    this.currentUser = null;
  }

  async login(credentials: LoginCredentials): Promise<User> {"
)
</tool_calls>`,
    tokens: 180,
    tags: ['edit', 'file'],
  },
];

/**
 * 根据类型获取示例
 */
export function getExamplesByType(type: ExampleType): FewShotExample[] {
  return FEW_SHOT_EXAMPLES.filter((e) => e.type === type);
}

/**
 * 根据标签获取示例
 */
export function getExamplesByTags(tags: string[]): FewShotExample[] {
  return FEW_SHOT_EXAMPLES.filter((e) =>
    tags.some((tag) => e.tags.includes(tag))
  );
}

/**
 * 获取最相关的示例
 *
 * @param taskDescription 任务描述
 * @param maxExamples 最大示例数
 * @param maxTokens token 限制
 */
export function selectRelevantExamples(
  taskDescription: string,
  maxExamples: number = 2,
  maxTokens: number = 400
): FewShotExample[] {
  const normalizedTask = taskDescription.toLowerCase();

  // 关键词匹配评分
  const scored = FEW_SHOT_EXAMPLES.map((example) => {
    let score = 0;

    // 标签匹配
    for (const tag of example.tags) {
      if (normalizedTask.includes(tag)) {
        score += 10;
      }
    }

    // 标题匹配
    if (normalizedTask.includes(example.title.toLowerCase())) {
      score += 5;
    }

    // 类型关键词匹配
    const typeKeywords: Record<ExampleType, string[]> = {
      parallel_dispatch: ['并行', '多个', '同时', '维度', 'parallel'],
      subagent_delegation: ['探索', '分析', '找到', '搜索', 'explore'],
      error_recovery: ['错误', '失败', '恢复', 'error', 'failed'],
      plan_mode: ['规划', '设计', '实现', '方案', 'plan'],
      code_review: ['审查', '审计', 'review', 'audit'],
      git_commit: ['提交', 'commit', 'git'],
      file_edit: ['修改', '编辑', 'edit', 'change'],
    };

    const keywords = typeKeywords[example.type] || [];
    for (const keyword of keywords) {
      if (normalizedTask.includes(keyword)) {
        score += 3;
      }
    }

    return { example, score };
  });

  // 按分数排序并选择
  const sorted = scored
    .filter((s) => s.score > 0)
    .sort((a, b) => b.score - a.score);

  const selected: FewShotExample[] = [];
  let totalTokens = 0;

  for (const { example } of sorted) {
    if (selected.length >= maxExamples) break;
    if (totalTokens + example.tokens > maxTokens) continue;

    selected.push(example);
    totalTokens += example.tokens;
  }

  return selected;
}

/**
 * 将示例格式化为 prompt 片段
 */
export function formatExamplesForPrompt(examples: FewShotExample[]): string {
  if (examples.length === 0) return '';

  const formatted = examples.map((e) =>
    `### 示例: ${e.title}

**用户**: ${e.userPrompt}

**助手**: ${e.assistantResponse}`
  );

  return `<few-shot-examples>
${formatted.join('\n\n---\n\n')}
</few-shot-examples>`;
}
