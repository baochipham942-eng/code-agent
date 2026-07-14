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
  | 'file_edit'
  | 'ppt_creation';

/**
 * 示例所属领域
 *
 * Neo 是产物为主轴的 cowork 产品，默认用户是非程序员协作者。「帮我做份营销方案 PPT」
 * 的范本不该是「先探索代码库、分五个 Phase 编码」。domain 让两类示例互不串台，
 * 选择逻辑见 selectRelevantExamples。
 */
export type ExampleDomain = 'code' | 'artifact';

/**
 * Few-shot 示例定义
 */
export interface FewShotExample {
  type: ExampleType;
  domain: ExampleDomain;
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
    domain: 'code',
    title: '多维度安全审计',
    userPrompt: '对项目进行全面的安全审计',
    assistantResponse: `我将从多个维度并行审计，使用 AgentSpawn 并行派发 4 个 reviewer 子代理：

1. **认证授权审计** — 检查身份验证、访问控制、会话管理
2. **输入验证审计** — 检查 SQL 注入、XSS、命令注入
3. **数据安全审计** — 检查敏感数据处理、加密、存储安全
4. **依赖安全审计** — 检查第三方依赖漏洞

[调用 AgentSpawn，parallel=true，agents 中放入 4 个 reviewer，每个聚焦一个维度]

所有审计完成后，我将汇总发现并按严重程度排序。`,
    tokens: estimateTokens(`我将从多个维度并行审计，使用 AgentSpawn 并行派发 4 个 reviewer 子代理：1. 认证授权审计 2. 输入验证审计 3. 数据安全审计 4. 依赖安全审计 [调用 AgentSpawn parallel=true] 所有审计完成后，我将汇总发现并按严重程度排序。`),
    tags: ['audit', 'security', 'parallel'],
  },
  {
    type: 'parallel_dispatch',
    domain: 'code',
    title: '代码质量多维度分析',
    userPrompt: '分析这个模块的代码质量',
    assistantResponse: `我将用 AgentSpawn 并行派发 3 个子代理分析代码质量：

1. **可维护性** — reviewer 检查代码结构、命名规范、模块耦合度
2. **性能** — reviewer 检查算法复杂度、内存使用、潜在瓶颈
3. **测试覆盖** — reviewer 检查测试完整性、边界条件处理

[调用 AgentSpawn，parallel=true，agents 中放入 3 个 reviewer，各自聚焦一个维度]

汇总后给出整体评分和优先改进建议。`,
    tokens: estimateTokens(`我将用 AgentSpawn 并行派发 3 个子代理分析代码质量：1. 可维护性 2. 性能 3. 测试覆盖 [调用 AgentSpawn parallel=true] 汇总后给出整体评分和优先改进建议。`),
    tags: ['quality', 'parallel'],
  },

  // ----------------------------------------------------------------------------
  // 子代理委派示例
  // ----------------------------------------------------------------------------
  {
    type: 'subagent_delegation',
    domain: 'code',
    title: '代码探索委派',
    userPrompt: '帮我找到所有处理用户认证的代码',
    assistantResponse: `这需要广泛搜索代码库，我委派一个 explore 子代理来处理。

[调用 Task 工具，subagent_type="explore"，指示其搜索 auth/login/authenticate 相关文件、认证中间件、JWT/session 处理逻辑，返回完整文件路径和关键代码位置]

等待探索结果后，我会整理为清晰的代码地图。`,
    tokens: estimateTokens(`这需要广泛搜索代码库，我委派一个 explore 子代理来处理。[调用 Task 工具] 等待探索结果后，我会整理为清晰的代码地图。`),
    tags: ['explore', 'delegation'],
  },
  {
    type: 'subagent_delegation',
    domain: 'code',
    title: '架构分析委派',
    userPrompt: '分析这个项目的整体架构',
    assistantResponse: `架构分析需要全局视角，我委派一个 plan 子代理进行深度探索。

[调用 Task 工具，subagent_type="plan"，指示其识别分层结构、分析模块职责、追踪数据流和控制流、梳理依赖关系]

子代理完成后，我将基于其发现生成架构概览。`,
    tokens: estimateTokens(`架构分析需要全局视角，我委派一个 plan 子代理进行深度探索。[调用 Task 工具] 子代理完成后，我将基于其发现生成架构概览。`),
    tags: ['architecture', 'plan', 'delegation'],
  },

  // ----------------------------------------------------------------------------
  // 错误恢复示例
  // ----------------------------------------------------------------------------
  {
    type: 'error_recovery',
    domain: 'code',
    title: '工具失败后的恢复',
    userPrompt: '（接上文，Edit 失败）',
    assistantResponse: `Edit 失败了，文件内容与预期不符。恢复步骤：

1. **重新读取文件** — 用 Read 获取最新内容，确认实际文本
2. **定位差异** — 对比 Edit 的 old_text 与实际内容，找出不匹配原因（空格？换行？已被修改？）
3. **重新编辑** — 基于最新内容构建正确的 edits 数组再次 Edit

如果第二次仍失败，我将改用 Write 重写整个文件。`,
    tokens: estimateTokens(`Edit 失败了，文件内容与预期不符。恢复步骤：1. 重新读取文件 2. 定位差异 3. 重新编辑。如果第二次仍失败，我将改用 Write 重写整个文件。`),
    tags: ['error', 'recovery', 'edit'],
  },

  // ----------------------------------------------------------------------------
  // Plan Mode 示例
  // ----------------------------------------------------------------------------
  {
    type: 'plan_mode',
    domain: 'code',
    title: 'Plan Mode 执行流程',
    userPrompt: '帮我实现一个新的用户管理功能',
    assistantResponse: `这是一个复杂任务，我将分阶段执行：

**Phase 1: 探索** — 使用 AgentSpawn 并行派发 2 个 explore 子代理，分别探索用户相关代码和数据库 schema
**Phase 2: 设计** — 基于探索结果，用 plan 子代理设计实现方案
**Phase 3: 确认** — 用 AskUserQuestion 确认关键设计决策（数据模型、API 接口、权限模型）
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
    domain: 'code',
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
    domain: 'code',
    title: '精确编辑代码文件',
    userPrompt: '在 AuthService 中添加 logout 方法',
    assistantResponse: `先用 Read 读取 authService.ts 确认当前内容和插入位置。

然后用 Edit 精确插入 logout 方法：
- edits[0].old_text: 定位到插入点附近的唯一代码片段
- edits[0].new_text: 在该位置前插入 logout 方法

只修改需要变更的部分，不重写整个文件。`,
    tokens: estimateTokens(`先用 Read 读取文件确认当前内容。然后用 Edit 精确插入方法。只修改需要变更的部分，不重写整个文件。`),
    tags: ['edit', 'file'],
  },

  // ----------------------------------------------------------------------------
  // 产物示例（domain: 'artifact'）
  //
  // 非程序员协作者的行为范本，开场是：先落一版产物、把假设摆明、让人改，
  // 而不是先探索代码库、也不是先分五个 Phase。
  //
  // 目前只有 PPT 一条。做表 / 写报告 / 做设计三条已写好但被撤下——它们依赖的
  // isExcelTask / isDocumentTask / isImageTask 检测靠裸英文词做子串匹配，与代码
  // 标识符全面碰撞，接上去会把编程 prompt 从「无示例」变成「错示例」。原文与证据见
  // specs/2026-07-14-artifact-intent-detection-signal-strength.md。
  //
  // ⚠️ tags / typeKeywords 只用具体产物名词（ppt / 演示稿），绝不用意图动词
  // （设计 / 规划 / 方案 / design / plan）。getTaskDescriptionFromFeatures 给编程任务
  // 生成的描述串里含 'plan design' 等词，产物示例一旦用这些词当标签，就会反过来劫持
  // 编程任务的示例选择。
  // ----------------------------------------------------------------------------
  {
    type: 'ppt_creation',
    domain: 'artifact',
    title: '做演示稿',
    userPrompt: '帮我做一份 Q3 营销方案的 PPT',
    assistantResponse: `我先把骨架搭出来给你看，不确定的地方我按常见做法假设，你直接改。

**我的假设**（不对就说）：内部季度汇报、10 页左右、主线走 Q3 目标 → 现状差距 → 打法 → 预算排期 → 衡量指标。

[调用 Skill 工具，command="frontend-slides"，args="Q3 营销方案，10 页，企业汇报风格"，先产出 outline.md 和逐页 prompts]

outline 出来我先贴给你确认主线，再合成 PPTX。**手上有 Q3 目标数字或上季度数据就发我**——没有的话我会在页面上标「示例数据」，不编造。`,
    tokens: estimateTokens(`我先把骨架搭出来给你看，不确定的地方按常见做法假设，你直接改。我的假设：内部季度汇报、10 页、主线 Q3 目标→现状差距→打法→预算排期→指标。[Skill command=frontend-slides] 先产出 outline.md 再合成 PPTX。有数据发我，没有我标示例数据，不编造。`),
    tags: ['ppt', '演示稿', 'slides'],
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
      // 产物类：只用具体产物名词，理由见上方产物示例区的注释
      ppt_creation: ['ppt', '演示稿', '幻灯片'],
    };

    const keywords = typeKeywords[example.type] || [];
    for (const keyword of keywords) {
      if (normalizedTask.includes(keyword)) {
        score += 3;
      }
    }

    return { example, score };
  });

  const hits = scored.filter((s) => s.score > 0);

  // 产物任务不拿编程示例当范本：命中任一产物示例时，编程示例整体退出候选。
  // 只靠分数排序不够——maxExamples 默认 2，plan_mode 这类通用编程示例（tag 'plan' 恒中）
  // 会稳稳占住第二个坑位，「帮我做份 PPT」照样被喂一份「分五个 Phase 编码」的范本。
  // ponytail: 上限是 detectTaskFeatures 的子串匹配误判——'实现 image 上传功能' 会被判成
  // 产物任务而拿到设计示例。要根治得给 detectTaskFeatures 加词边界，那是另一个工单的面。
  const artifactHits = hits.filter((s) => s.example.domain === 'artifact');
  const pool = artifactHits.length > 0 ? artifactHits : hits;

  // 按分数排序并选择
  const sorted = pool.sort((a, b) => b.score - a.score);

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
