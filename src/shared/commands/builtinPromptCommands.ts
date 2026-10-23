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

/**
 * /init-memory — 让 agent 读当前文件夹（含文档、表格），起草三条待确认项目记忆。
 * 已有同键只给改进建议，不覆盖。确认入口是 Settings -> Memory（设置页签「记忆」）。
 */
const INIT_MEMORY_TEMPLATE = `为当前工作目录起草项目记忆。这些草稿只作为待确认候选保存，在用户确认之前不会生效。

严格按以下步骤执行：

1. 用 ListDirectory 列出当前工作目录。目录不存在、为空、或一个文件都读不了时：直接说明这一点，不要调用 ProposeProjectMemory。

2. 用工具阅读，不要凭空猜：
   - 有 README（README、README.md、readme.txt 等）就用 Read 读它。
   - 再读最多 10 个最能说明「这是做什么的、有哪些关键文件、使用者有什么约定」的文件，任何类型都可以。
   - 二进制文档不要用 Read 硬读。.docx 用 read_docx，.xlsx / .xls 用 read_xlsx，.pdf 用 read_pdf；类型不确定时用 ReadDocument。这些读取工具若不在当前工具表里，先用 ToolSearch 按 select:工具名 加载。
   - 读不到的文件在回复里说明，不要编造内容。

3. 判断这是代码项目还是非代码项目（文档、表格、笔记、图片说明都算非代码）。两种都写下面三个主题。非代码项目用普通人能读懂的话写用途和文件，不要只罗列文件夹名字。

4. ProposeProjectMemory 不在常驻工具表里。先调用 ToolSearch，查询 select:ProposeProjectMemory，加载成功后再写。不要调用 MemoryWrite。

5. 每个主题调用一次 ProposeProjectMemory。topic 只能是 purpose、key-files、conventions：
   - purpose：这个项目是做什么的
   - key-files：关键文件，每行一个相对路径加一句话
   - conventions：从文件里观察到的使用者约定
   参数还有 summary（一行摘要）、content（正文）、sources（你实际读过的、位于当前工作目录内的相对路径，至少一条）。
   只写文件里确证的事实。语言跟随文件夹的主语言（文档或注释是中文就用中文）。

6. 若工具返回 exists, not overwritten：不要重试该主题，不要覆盖。在回复里引用已有正文，并给出改进建议。

7. 最终回复必须：
   - 逐字引用每一条草稿的全文（刚写入的，以及已存在所以没覆盖的）
   - 写明这些草稿要在 Settings -> Memory（设置里的「记忆」页）确认后才会生效
   - 空目录或读不到文件时说明没有写入`;

export const BUILTIN_PROMPT_COMMANDS: PromptCommandInfo[] = [
  {
    name: 'init',
    description: '分析当前代码库，生成 CLAUDE.md 项目记忆草稿（不覆盖已有）',
    source: 'builtin',
    template: INIT_TEMPLATE,
    hints: computeHints(INIT_TEMPLATE),
  },
  {
    name: 'init-memory',
    description: '阅读当前文件夹，起草待确认的项目记忆（用途、关键文件、约定），不覆盖已有条目',
    source: 'builtin',
    template: INIT_MEMORY_TEMPLATE,
    hints: computeHints(INIT_MEMORY_TEMPLATE),
  },
];
