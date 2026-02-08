// ============================================================================
// Built-in Skills - 内置 Skill 定义
// ============================================================================

import type { ParsedSkill } from '../../../shared/types/agentSkill';

/**
 * 内置 Skill 定义列表
 * 这些 Skill 会自动加载，用户无需额外配置
 */
export const BUILTIN_SKILLS: ParsedSkill[] = [
  {
    name: 'commit',
    description: '创建 Git commit，自动生成 commit message',
    promptContent: `请帮我创建一个 Git commit。

1. 首先运行 git status 查看当前状态
2. 如果有未暂存的更改，询问用户是否需要先暂存
3. 分析已暂存的更改内容
4. 生成一个符合 Conventional Commits 规范的 commit message
5. 执行 git commit

Commit message 格式：
- feat: 新功能
- fix: Bug 修复
- docs: 文档更新
- style: 代码格式（不影响代码运行的变动）
- refactor: 重构
- test: 测试相关
- chore: 其他修改

请确保 commit message 简洁明了，概括此次更改的主要内容。`,
    basePath: '',
    allowedTools: ['bash', 'read_file', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    bins: ['git'],
  },
  {
    name: 'review',
    description: '代码审查，检查代码质量和潜在问题',
    promptContent: `请对指定的代码进行审查。

审查要点：
1. **代码质量**：变量命名、函数长度、代码复杂度
2. **潜在 Bug**：空指针、边界条件、异常处理
3. **安全性**：输入验证、SQL 注入、XSS
4. **性能**：循环优化、缓存使用、内存泄漏
5. **可维护性**：注释、模块化、测试覆盖

输出格式：
- 问题严重程度：🔴 严重 / 🟡 警告 / 🟢 建议
- 问题位置：文件名:行号
- 问题描述和修复建议

请逐个文件进行审查，最后给出总体评价。`,
    basePath: '',
    allowedTools: ['read_file', 'glob', 'grep'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'test',
    description: '运行测试并分析结果',
    promptContent: `请运行项目测试并分析结果。

步骤：
1. 检测项目类型（查看 package.json、setup.py、Cargo.toml 等）
2. 运行相应的测试命令
3. 分析测试输出
4. 如果有失败的测试，分析原因并给出修复建议

常见测试命令：
- Node.js: npm test / npm run test / yarn test
- Python: pytest / python -m pytest
- Rust: cargo test
- Go: go test ./...

输出包括：
- 测试总数
- 通过数/失败数
- 失败测试的详细信息
- 建议的修复方案`,
    basePath: '',
    allowedTools: ['bash', 'read_file'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'explain',
    description: '解释代码功能和工作原理',
    promptContent: `请解释指定代码的功能和工作原理。

解释应包括：
1. **总体功能**：这段代码的主要目的
2. **核心逻辑**：关键算法或数据流程
3. **依赖关系**：使用的外部库或模块
4. **输入输出**：函数参数和返回值
5. **注意事项**：潜在的陷阱或使用限制

请用通俗易懂的语言，适合初学者理解。如果代码较复杂，可以分步骤解释。`,
    basePath: '',
    allowedTools: ['read_file', 'grep', 'glob'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'refactor',
    description: '重构代码，提高可读性和可维护性',
    promptContent: `请对指定代码进行重构。

重构原则：
1. **保持功能不变**：重构不应改变代码行为
2. **提高可读性**：改善命名、简化逻辑
3. **减少重复**：提取公共函数、使用设计模式
4. **增强可维护性**：模块化、解耦合

重构步骤：
1. 先理解现有代码的功能
2. 识别代码异味（Code Smells）
3. 逐步进行小幅重构
4. 每次重构后确保测试通过

请在修改前说明重构意图，在修改后解释改进点。`,
    basePath: '',
    allowedTools: ['read_file', 'edit_file', 'write_file', 'bash'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
  {
    name: 'docker',
    description: '管理 Docker 容器和镜像',
    promptContent: `帮助管理 Docker 容器和镜像。

可执行的操作：
1. **查看状态**：列出容器、镜像、网络
2. **容器管理**：启动、停止、重启、删除容器
3. **镜像管理**：拉取、构建、删除镜像
4. **日志查看**：查看容器日志
5. **调试**：进入容器 shell、检查配置

注意事项：
- 执行删除操作前会先确认
- 不会执行 docker system prune 等危险命令
- 会显示命令执行结果`,
    basePath: '',
    allowedTools: ['bash', 'ask_user_question'],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
    bins: ['docker'],
  },
  {
    name: 'ppt',
    description: '智能 PPT 生成（SCQA 框架、自动判断联网搜索、控制图表数量）',
    promptContent: `# PPT 生成专家

你是专业的演示文稿专家。输出 .pptx 文件，用户可直接用 PowerPoint/WPS/Keynote 编辑。

**🚨 关键原则：先收集信息，再生成 PPT！内容必须来自实际搜索/读取结果！**

---

## Step 1: 判断信息来源（必做）

### 场景 A：本地项目（如工作目录下的项目）
**必须先读取项目文件获取真实信息：**
1. \`read_file("CLAUDE.md")\` - 项目概述
2. \`read_file("README.md")\` - 功能介绍
3. \`read_file("docs/ARCHITECTURE.md")\` - 架构设计
4. \`read_file("package.json")\` - 技术栈

### 场景 B：公共产品/技术
**必须执行 3 次 web_search：**
1. "{topic} 核心功能 特性 官方文档 2026"
2. "{topic} 技术架构 原理 实现细节"
3. "{topic} 用户评价 案例 使用数据"

### 场景 C：用户已提供完整内容
直接使用用户提供的内容。

**❌ 禁止凭空捏造内容！必须基于搜索/读取的真实数据！**

---

## Step 2: 构建大纲（SCQA 框架）

| 类型 | 内容 | 布局 |
|------|------|------|
| S - Situation | 行业背景、市场现状 | highlight |
| C - Complication | 痛点、挑战 | cards |
| Q - Question | 核心问题（可隐含） | - |
| A - Answer | 解决方案、功能特性 | list / cards |
| E - Evidence | 数据支撑、案例 | stats |

**10 页 PPT 标准结构**：
1. 封面
2. 行业背景（S）
3. 核心价值（A）
4. 行业数据（E）- 可用图表
5. 功能特性（A）
6. 技术架构（A）- 可用图表
7. 工作流程（A）- 可用图表
8. 应用效果（E）
9. 使用场景（A）
10. 总结/谢谢

---

## Step 3: 图表决策

**原生可编辑图表（自动）：**
- 包含数字/百分比的数据内容 → ppt_generate 会自动生成原生可编辑图表
- 用户下载后可在 PowerPoint 中直接编辑图表数据
- 无需手动调用 mermaid_export

**如果需要复杂流程图：**
- 工作流程/架构图 → 可用 mermaid_export 生成透明 PNG，通过 images 参数传入
- 10 页 PPT 最多 1-2 张流程图

---

## Step 4: 生成 PPTX

**默认 10 页，用户要求 5 页时也至少生成 8 页（内容更充实）**

\`\`\`
ppt_generate({
  topic: "标题",
  content: "# 封面\\n## 副标题\\n# 技术架构\\n- 要点1（来自搜索结果）\\n- 要点2（具体数据）",
  theme: "neon-green",
  slides_count: 10
})
\`\`\`

**⚠️ content 中的每个要点必须来自 Step 1 收集的真实信息！**

**主题选项**：
- \`neon-green\`: 霓虹绿（科技感，推荐）
- \`neon-blue\`: 电光蓝（专业感）
- \`neon-purple\`: 霓虹紫（创意感）
- \`apple-dark\`: 苹果发布会极简风格（纯黑背景）
- \`corporate\`: 企业蓝（商务感）

---

## 内容质量要求

❌ 空洞：
- 支持多语言
- 性能优秀

✅ 具体：
- 🌍 **50+ 编程语言**支持
- ⚡ **延迟 < 100ms**，比传统方案快 3 倍

---

## ❌ 禁止事项

1. **禁止每页都放图表** - 10 页最多 3-4 张
2. **禁止内容空洞** - 必须有具体数据和案例
3. **禁止跳过信息收集** - 公共产品要 web_search，本地项目要 read_file
4. **禁止少于 8 页** - 即使用户说 5 页，也要生成 8-10 页以保证内容质量`,
    basePath: '',
    allowedTools: [
      'ask_user_question',
      'read_file',
      'read_pdf',
      'glob',
      'list_directory',
      'web_search',
      'web_fetch',
      'mermaid_export',
      'ppt_generate',
    ],
    disableModelInvocation: false,
    userInvocable: true,
    executionContext: 'inline',
    source: 'builtin',
  },
];

/**
 * 获取所有内置 Skills
 */
export function getBuiltinSkills(): ParsedSkill[] {
  return BUILTIN_SKILLS;
}

/**
 * 按名称获取内置 Skill
 */
export function getBuiltinSkill(name: string): ParsedSkill | undefined {
  return BUILTIN_SKILLS.find(skill => skill.name === name);
}

/**
 * 检查是否为内置 Skill
 */
export function isBuiltinSkill(name: string): boolean {
  return BUILTIN_SKILLS.some(skill => skill.name === name);
}
