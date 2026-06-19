// ============================================================================
// 内置 prompt 命令 — onboarding 标配（/init 等）
// ============================================================================
// 与文件式（.code-agent/commands/*.md）/ MCP prompts 同构，统一进
// PromptCommandService.listCommands；优先级最低，可被同名用户/项目文件覆盖。
//
// 这些命令展开成一段驱动 agent 的指令——靠 agent 自带的 listDirectory /
// readFile / writeFile 工具真读代码生成产物，而非确定性脚本拼模板，
// 因此输出质量随模型能力提升而提升。
// ============================================================================

import { computeHints, type PromptCommandInfo } from './promptCommands';

/**
 * /init — 分析当前代码库，生成 CLAUDE.md 项目记忆草稿。
 * 防覆盖、语言自适应、产出后交还用户编辑，全部写进指令由 agent 执行。
 */
const INIT_TEMPLATE = `分析当前代码库，为它生成一份 CLAUDE.md 项目记忆文件草稿（供 AI 编程助手后续会话加载）。

严格按以下步骤执行：

1. **先防覆盖**：检查项目根目录是否已存在 CLAUDE.md（或 AGENTS.md）。
   - 若已存在：不要覆盖。读取现有内容，向用户说明已存在，并提出可补充/更新的点，等用户确认后再动；不要直接写文件。
   - 若不存在：继续下面的分析与生成。

2. **分析代码库**（用 listDirectory / readFile 等工具，不要凭空猜）：
   - 读取依赖清单（package.json / pyproject.toml / go.mod / Cargo.toml / pom.xml 等）识别语言与技术栈。
   - 扫描顶层目录结构，理解分层（源码 / 测试 / 文档 / 脚本）。
   - 提取关键命令：构建 / 测试 / 运行 / lint / typecheck（来自 scripts、Makefile、README 等）。
   - 读取 README / 现有 docs 把握项目目标与约定。

3. **生成 CLAUDE.md 草稿**，写到项目根目录，内容简洁、只写从代码库确证的事实，覆盖：
   - 项目目标与一句话定位
   - 技术栈
   - 目录结构与分层约定
   - 常用命令（构建 / 测试 / 运行 / lint）
   - 代码约定（命名、语言、提交纪律等可观察到的）
   语言跟随项目主语言（注释/文档为中文则用中文）。避免冗长，宁缺毋滥，不要编造不确定的内容。

4. 写完后告诉用户：这是**草稿**，请 review 并按需编辑；列出你不确定、需要他补充的点。`;

export const BUILTIN_PROMPT_COMMANDS: PromptCommandInfo[] = [
  {
    name: 'init',
    description: '分析当前代码库，生成 CLAUDE.md 项目记忆草稿（不覆盖已有）',
    source: 'builtin',
    template: INIT_TEMPLATE,
    hints: computeHints(INIT_TEMPLATE),
  },
];
