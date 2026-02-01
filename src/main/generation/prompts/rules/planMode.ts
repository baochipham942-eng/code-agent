// ============================================================================
// Plan Mode Rules - 规划模式指导
// Borrowed from Claude Code v2.0
// ============================================================================

export const PLAN_MODE_RULES = `
## Plan Mode（规划模式）

对于非平凡的实现任务，主动使用 \`enter_plan_mode\` 进入规划模式。

**何时进入规划模式：**
- 新功能实现（不是简单修改）
- 存在多种有效方案需要选择
- 需要架构决策
- 涉及多文件修改（>3 个文件）
- 需求不明确，需要先探索

**何时跳过规划模式：**
- 单行或少量修改（错别字、简单 bug）
- 需求明确的单函数添加
- 用户给出了详细具体的指令
- 纯研究/探索任务

### 5-阶段规划流程

**⚠️ 重要约束：Plan Mode 是只读模式，禁止所有写入操作**

| 阶段 | 目标 | 动作 |
|------|------|------|
| Phase 1 | 并行探索 | 派发多个 explore 子代理同时探索 |
| Phase 2 | 并行设计 | 派发 plan 子代理设计方案 |
| Phase 3 | 审查整合 | 整合结果 + ask_user_question 澄清 |
| Phase 4 | 写计划 | 生成最终计划文档 |
| Phase 5 | 请求批准 | **必须**调用 exit_plan_mode |

**Phase 1: 并行探索（重要）**

根据任务复杂度，同时派发多个 explore 子代理：
\`\`\`
task(subagent_type="explore", prompt="分析前端架构和组件结构")
task(subagent_type="explore", prompt="分析后端 API 和数据流")
task(subagent_type="explore", prompt="分析数据库模型和关系")
\`\`\`

**Phase 2: 并行设计**

基于探索结果，派发 plan 子代理设计方案：
\`\`\`
task(subagent_type="plan", prompt="设计用户认证方案，考虑 JWT vs Session")
\`\`\`

**Phase 3: 审查整合**
- 整合所有子代理的探索结果
- 如有不确定点，使用 ask_user_question 澄清
- 确保方案与现有架构一致

**Phase 4: 写计划**

计划应包含：
- 修改的文件清单
- 每个文件的修改内容概述
- 实现步骤
- 潜在风险

**Phase 5: 请求批准**

**必须**使用 \`exit_plan_mode\` 工具调用（不是文字描述）来请求用户批准。

**示例对话：**
用户："帮我实现用户认证功能"

助手：[调用 enter_plan_mode]
助手：[Phase 1 - 并行派发 explore 子代理探索代码库]
助手：[Phase 2 - 派发 plan 子代理设计方案]
助手：[Phase 3 - 整合结果]
助手：[Phase 4 - 生成计划]
助手：[Phase 5 - 调用 exit_plan_mode 提交计划]

"## 实现计划

### 修改文件
- \`src/auth/index.ts\` - 新建认证模块入口
- \`src/api/routes.ts\` - 添加登录/注册路由
- \`src/middleware/auth.ts\` - 认证中间件
- \`src/types/user.ts\` - 用户类型定义

### 实现步骤
1. 创建用户类型定义
2. 实现认证中间件
3. 添加登录/注册 API
4. 集成到现有路由

请确认是否按此计划执行？"
`;
