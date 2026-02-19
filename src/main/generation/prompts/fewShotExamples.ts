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
    assistantResponse: `我将从多个维度并行审计，同时派发 4 个 reviewer 子代理：

1. **认证授权审计** — 检查身份验证、访问控制、会话管理
2. **输入验证审计** — 检查 SQL 注入、XSS、命令注入
3. **数据安全审计** — 检查敏感数据处理、加密、存储安全
4. **依赖安全审计** — 检查第三方依赖漏洞

[并行调用 4 次 task 工具，每个使用 subagent_type="reviewer"，各自聚焦一个维度]

所有审计完成后，我将汇总发现并按严重程度排序。`,
    tokens: estimateTokens(`我将从多个维度并行审计，同时派发 4 个 reviewer 子代理：1. 认证授权审计 2. 输入验证审计 3. 数据安全审计 4. 依赖安全审计 [并行调用 4 次 task 工具] 所有审计完成后，我将汇总发现并按严重程度排序。`),
    tags: ['audit', 'security', 'parallel'],
  },
  {
    type: 'parallel_dispatch',
    title: '代码质量多维度分析',
    userPrompt: '分析这个模块的代码质量',
    assistantResponse: `我将并行派发 3 个子代理分析代码质量：

1. **可维护性** — reviewer 检查代码结构、命名规范、模块耦合度
2. **性能** — reviewer 检查算法复杂度、内存使用、潜在瓶颈
3. **测试覆盖** — reviewer 检查测试完整性、边界条件处理

[并行调用 3 次 task 工具，各自聚焦一个维度]

汇总后给出整体评分和优先改进建议。`,
    tokens: estimateTokens(`我将并行派发 3 个子代理分析代码质量：1. 可维护性 2. 性能 3. 测试覆盖 [并行调用 3 次 task 工具] 汇总后给出整体评分和优先改进建议。`),
    tags: ['quality', 'parallel'],
  },

  // ----------------------------------------------------------------------------
  // 子代理委派示例
  // ----------------------------------------------------------------------------
  {
    type: 'subagent_delegation',
    title: '代码探索委派',
    userPrompt: '帮我找到所有处理用户认证的代码',
    assistantResponse: `这需要广泛搜索代码库，我委派一个 explore 子代理来处理。

[调用 task 工具，subagent_type="explore"，指示其搜索 auth/login/authenticate 相关文件、认证中间件、JWT/session 处理逻辑，返回完整文件路径和关键代码位置]

等待探索结果后，我会整理为清晰的代码地图。`,
    tokens: estimateTokens(`这需要广泛搜索代码库，我委派一个 explore 子代理来处理。[调用 task 工具] 等待探索结果后，我会整理为清晰的代码地图。`),
    tags: ['explore', 'delegation'],
  },
  {
    type: 'subagent_delegation',
    title: '架构分析委派',
    userPrompt: '分析这个项目的整体架构',
    assistantResponse: `架构分析需要全局视角，我委派一个 plan 子代理进行深度探索。

[调用 task 工具，subagent_type="plan"，指示其识别分层结构、分析模块职责、追踪数据流和控制流、梳理依赖关系]

子代理完成后，我将基于其发现生成架构概览。`,
    tokens: estimateTokens(`架构分析需要全局视角，我委派一个 plan 子代理进行深度探索。[调用 task 工具] 子代理完成后，我将基于其发现生成架构概览。`),
    tags: ['architecture', 'plan', 'delegation'],
  },

  // ----------------------------------------------------------------------------
  // 错误恢复示例
  // ----------------------------------------------------------------------------
  {
    type: 'error_recovery',
    title: '工具失败后的恢复',
    userPrompt: '（接上文，edit_file 失败）',
    assistantResponse: `edit_file 失败了，文件内容与预期不符。恢复步骤：

1. **重新读取文件** — 用 read_file 获取最新内容，确认实际文本
2. **定位差异** — 对比 old_string 与实际内容，找出不匹配原因（空格？换行？已被修改？）
3. **重新编辑** — 基于最新内容构建正确的 old_string 再次 edit_file

如果第二次仍失败，我将改用 write_file 重写整个文件。`,
    tokens: estimateTokens(`edit_file 失败了，文件内容与预期不符。恢复步骤：1. 重新读取文件 2. 定位差异 3. 重新编辑。如果第二次仍失败，我将改用 write_file 重写整个文件。`),
    tags: ['error', 'recovery', 'edit'],
  },

  // ----------------------------------------------------------------------------
  // Plan Mode 示例
  // ----------------------------------------------------------------------------
  {
    type: 'plan_mode',
    title: 'Plan Mode 执行流程',
    userPrompt: '帮我实现一个新的用户管理功能',
    assistantResponse: `这是一个复杂任务，我将分阶段执行：

**Phase 1: 探索** — 并行派发 2 个 explore 子代理，分别探索用户相关代码和数据库 schema
**Phase 2: 设计** — 基于探索结果，用 plan 子代理设计实现方案
**Phase 3: 确认** — 用 ask_user_question 确认关键设计决策（数据模型、API 接口、权限模型）
**Phase 4: 实施** — 按计划逐步编码，每完成一个模块立即验证
**Phase 5: 验证** — 运行类型检查和测试，确认功能完整

先开始 Phase 1 的探索。`,
    tokens: estimateTokens(`这是一个复杂任务，我将分阶段执行：Phase 1: 探索 Phase 2: 设计 Phase 3: 确认 Phase 4: 实施 Phase 5: 验证 先开始 Phase 1 的探索。`),
    tags: ['plan', 'complex'],
  },

  // ----------------------------------------------------------------------------
  // Git 提交示例
  // ----------------------------------------------------------------------------
  {
    type: 'git_commit',
    title: '规范的 Git 提交',
    userPrompt: '提交刚才的修改',
    assistantResponse: `先用 bash 运行 git status 查看变更文件列表。

确认变更文件后，用 bash 执行：
1. git add 添加相关文件（只添加本次修改的文件，不用 git add -A）
2. git commit 提交，消息格式遵循 conventional commits

我不会自动 push，除非你明确要求。`,
    tokens: estimateTokens(`先用 bash 运行 git status 查看变更文件列表。确认变更文件后，用 bash 执行 git add 和 git commit。我不会自动 push，除非你明确要求。`),
    tags: ['git', 'commit'],
  },

  // ----------------------------------------------------------------------------
  // 文件编辑示例
  // ----------------------------------------------------------------------------
  {
    type: 'file_edit',
    title: '精确编辑代码文件',
    userPrompt: '在 AuthService 中添加 logout 方法',
    assistantResponse: `先用 read_file 读取 authService.ts 确认当前内容和插入位置。

然后用 edit_file 精确插入 logout 方法：
- old_string: 定位到插入点附近的唯一代码片段
- new_string: 在该位置前插入 logout 方法

只修改需要变更的部分，不重写整个文件。`,
    tokens: estimateTokens(`先用 read_file 读取文件确认当前内容。然后用 edit_file 精确插入方法。只修改需要变更的部分，不重写整个文件。`),
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
    `<example>
Input: ${e.userPrompt}
Output: ${e.assistantResponse}
</example>`
  );

  return formatted.join('\n\n');
}
