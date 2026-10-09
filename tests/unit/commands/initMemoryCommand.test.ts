import { describe, expect, it, vi } from 'vitest';
import { BUILTIN_PROMPT_COMMANDS } from '../../../src/shared/commands/builtinPromptCommands';
import { initializeCommands } from '../../../src/shared/commands';
import { getCommandRegistry } from '../../../src/shared/commands/commandRegistry';
import type { CommandContext, CommandDefinition, CommandOutput } from '../../../src/shared/commands/types';
import type { ProjectMemoryDraftResult } from '../../../src/shared/contract/memory';

// 单条定义经 registry 取用（公开入口），definitions 文件只导出数组。
function initMemoryCommand(): CommandDefinition {
  initializeCommands();
  const def = getCommandRegistry().get('init-memory');
  if (!def) throw new Error('init-memory command not registered');
  return def;
}

const guiMemory = vi.hoisted(() => ({ calls: 0 }));

vi.mock('../../../src/renderer/services/memoryGuiSurface', () => ({
  initProjectMemoryViaGuiSurface: async () => {
    guiMemory.calls += 1;
    return {
      projectDir: '/gui/work',
      written: 2,
      skipped: [{ topic: 'readme-purpose' as const, reason: 'source-absent' as const }],
      entries: [],
    } satisfies ProjectMemoryDraftResult;
  },
}));

function makeCtx(overrides: Record<string, unknown> = {}): { ctx: CommandContext; lines: string[] } {
  const lines: string[] = [];
  const output: CommandOutput = {
    info: (msg) => lines.push(`info:${msg}`),
    success: (msg) => lines.push(`success:${msg}`),
    error: (msg) => lines.push(`error:${msg}`),
    warn: (msg) => lines.push(`warn:${msg}`),
  };
  return { lines, ctx: { surface: 'cli', output, ...overrides } as CommandContext };
}

const draftResult: ProjectMemoryDraftResult = {
  projectDir: '/tmp/work',
  written: 4,
  skipped: [],
  entries: [],
};

describe('/init-memory command', () => {
  it('registers on both surfaces with a system category', () => {
    initializeCommands();
    const def = getCommandRegistry().get('init-memory');
    expect(def?.surfaces).toEqual(['cli', 'gui']);
    expect(def?.category).toBe('system');
    expect(getCommandRegistry().list('cli').map((item: CommandDefinition) => item.id)).toContain('init-memory');
    expect(getCommandRegistry().list('gui').map((item: CommandDefinition) => item.id)).toContain('init-memory');
  });

  it('runs the injected drafter for the agent working directory and reports counts + review hint', async () => {
    const seen: string[] = [];
    const { ctx, lines } = makeCtx({
      agent: { getConfig: () => ({ workingDirectory: '/tmp/work' }) },
      loadProjectMemoryDrafter: async () => ({
        runProjectMemoryDraft: async (projectDir: string) => {
          seen.push(projectDir);
          return draftResult;
        },
      }),
    });
    const result = await initMemoryCommand().handler(ctx, []);
    expect(seen).toEqual(['/tmp/work']);
    expect(result).toEqual({ success: true, data: draftResult });
    expect(lines).toEqual([
      'info:/init-memory 完成：写入 4 条候选记忆，跳过 0 条主题。\n候选记忆需在记忆管理中人工确认后才会生效。',
    ]);
  });

  it('falls back to process.cwd() when the agent config has no working directory', async () => {
    const seen: string[] = [];
    const { ctx } = makeCtx({
      loadProjectMemoryDrafter: async () => ({
        runProjectMemoryDraft: async (projectDir: string) => {
          seen.push(projectDir);
          return { ...draftResult, written: 0, skipped: [{ topic: 'tech-stack', reason: 'source-absent' }] };
        },
      }),
    });
    const result = await initMemoryCommand().handler(ctx, []);
    expect(seen).toEqual([process.cwd()]);
    expect(result.success).toBe(true);
  });

  it('labels skipped topics by reason without failing the command', async () => {
    const { ctx, lines } = makeCtx({
      agent: { getConfig: () => ({ workingDirectory: '/tmp/work' }) },
      loadProjectMemoryDrafter: async () => ({
        runProjectMemoryDraft: async () => ({
          ...draftResult,
          written: 1,
          skipped: [
            { topic: 'tech-stack', reason: 'existing-key' },
            { topic: 'readme-purpose', reason: 'source-absent' },
          ],
        }),
      }),
    });
    const result = await initMemoryCommand().handler(ctx, []);
    expect(result.success).toBe(true);
    expect(lines[0]).toContain('写入 1 条候选记忆，跳过 2 条主题');
    expect(lines[0]).toContain('- 技术栈：同键记忆已存在，未覆盖');
    expect(lines[0]).toContain('- 项目定位：来源缺失');
  });

  it('reports a missing drafter port without leaving the handler', async () => {
    const { ctx, lines } = makeCtx();
    const result = await initMemoryCommand().handler(ctx, []);
    expect(result).toMatchObject({ success: false, message: 'loadProjectMemoryDrafter port is not available' });
    expect(lines).toEqual(['error:/init-memory 失败：loadProjectMemoryDrafter port is not available']);
  });

  it('keeps the GUI path on the renderer IPC surface', async () => {
    const load = vi.fn(async () => {
      throw new Error('cli drafter must not load');
    });
    const { ctx, lines } = makeCtx({ surface: 'gui', loadProjectMemoryDrafter: load });
    const result = await initMemoryCommand().handler(ctx, []);
    expect(guiMemory.calls).toBe(1);
    expect(load).not.toHaveBeenCalled();
    expect(result.success).toBe(true);
    expect(lines[0]).toContain('写入 2 条候选记忆，跳过 1 条主题');
    expect(lines[0]).toContain('- 项目定位：来源缺失');
  });
});

describe('/init builtin prompt command byte-for-byte pin (N-INIT-PROJECT-MEMORY-CMD)', () => {
  // /init-memory 是新增的 handler 命令；原 /init prompt 模板命令必须逐字不变。
  it('keeps the init entry and INIT_TEMPLATE unchanged', () => {
    expect(BUILTIN_PROMPT_COMMANDS).toHaveLength(1);
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
