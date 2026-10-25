import { describe, expect, it } from 'vitest';
import { BUILTIN_PROMPT_COMMANDS } from '../../../src/shared/commands/builtinPromptCommands';
import { initializeCommands } from '../../../src/shared/commands';
import { getCommandRegistry } from '../../../src/shared/commands/commandRegistry';

describe('/init-memory builtin prompt command', () => {
  it('is registered and tells the agent to use ProposeProjectMemory and Settings -> Memory', () => {
    const command = BUILTIN_PROMPT_COMMANDS.find((item) => item.name === 'init-memory');
    expect(command).toMatchObject({
      name: 'init-memory',
      source: 'builtin',
    });
    expect(command?.template).toContain('ProposeProjectMemory');
    expect(command?.template).toContain('Settings -> Memory');
    expect(command?.template).toContain('read_docx');
    expect(command?.template).toContain('read_xlsx');
    expect(command?.template).toContain('read_pdf');
    expect(command?.template).toContain('ReadDocument');
    expect(command?.template).toContain('exists, not overwritten');
    expect(command?.description).toBeTruthy();
  });

  it('is not a handler command', () => {
    initializeCommands();
    expect(getCommandRegistry().get('init-memory')).toBeUndefined();
  });
});

describe('/init builtin prompt command byte-for-byte pin (N-INIT-PROJECT-MEMORY-CMD)', () => {
  // /init-memory 改成 prompt 命令后，原 /init 模板必须逐字不变。
  it('keeps the init entry and INIT_TEMPLATE unchanged', () => {
    expect(BUILTIN_PROMPT_COMMANDS).toHaveLength(2);
    const init = BUILTIN_PROMPT_COMMANDS.find((command) => command.name === 'init');
    expect(init).toEqual({
      name: 'init',
      description: '分析当前代码库，生成 CLAUDE.md 项目记忆草稿（不覆盖已有）',
      source: 'builtin',
      template: `分析当前代码库，为它生成一份 CLAUDE.md 项目记忆文件草稿（供 AI 编程助手后续会话加载）。

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

4. 写完后告诉用户：这是**草稿**，请 review 并按需编辑；列出你不确定、需要他补充的点。`,
      hints: expect.any(Array) as unknown,
    });
  });
});
