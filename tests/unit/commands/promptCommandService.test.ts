// ============================================================================
// PromptCommandService — /命令注册表（roadmap 2.2）
// ============================================================================
// - 文件式自定义：~/.code-agent/commands/*.md（user）+ <wd>/.code-agent/commands/*.md
//   （project），project 同名覆盖 user
// - MCP prompts 自动入表（文件命令同名优先）
// - resolveInvocation：/name args → 模板展开 + agent/model/subtask 透传
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as os from 'os';

const mcpMocks = vi.hoisted(() => ({
  getPrompts: vi.fn(() => [] as Array<{ name: string; description?: string; serverName: string; arguments?: Array<{ name: string; required?: boolean }> }>),
  getPrompt: vi.fn(async () => 'mcp template body'),
}));

vi.mock('../../../src/host/mcp/mcpClient', () => ({
  getMCPClient: () => mcpMocks,
}));

const configMocks = vi.hoisted(() => ({
  userDir: '',
}));

vi.mock('../../../src/host/config/configPaths', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/host/config/configPaths')>();
  const path = await import('path');
  return {
    ...original,
    getCommandsDir: (workingDirectory?: string) => ({
      user: path.join(configMocks.userDir, 'commands'),
      ...(workingDirectory ? { project: path.join(workingDirectory, '.code-agent', 'commands') } : {}),
    }),
  };
});

const { PromptCommandService, applyPromptCommandExpansion } = await import(
  '../../../src/host/services/commands/promptCommandService'
);

describe('PromptCommandService', () => {
  let userDir: string;
  let projectDir: string;
  let service: InstanceType<typeof PromptCommandService>;

  beforeEach(async () => {
    userDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-user-'));
    projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'cmd-proj-'));
    configMocks.userDir = userDir;
    mcpMocks.getPrompts.mockReturnValue([]);
    mcpMocks.getPrompt.mockClear();
    await fs.mkdir(path.join(userDir, 'commands'), { recursive: true });
    await fs.mkdir(path.join(projectDir, '.code-agent', 'commands'), { recursive: true });
    service = new PromptCommandService();
  });

  afterEach(async () => {
    await fs.rm(userDir, { recursive: true, force: true });
    await fs.rm(projectDir, { recursive: true, force: true });
  });

  async function writeUserCommand(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(userDir, 'commands', `${name}.md`), content, 'utf-8');
  }
  async function writeProjectCommand(name: string, content: string): Promise<void> {
    await fs.writeFile(path.join(projectDir, '.code-agent', 'commands', `${name}.md`), content, 'utf-8');
  }

  it('lists file commands from user and project scopes', async () => {
    await writeUserCommand('daily', '---\ndescription: daily report\n---\nWrite report for $ARGUMENTS');
    await writeProjectCommand('ship', 'Ship checklist for $1');

    const commands = await service.listCommands(projectDir);
    const names = commands.filter((c) => c.source === 'file').map((c) => c.name).sort();
    expect(names).toEqual(['daily', 'ship']);
    expect(commands.find((c) => c.name === 'daily')?.description).toBe('daily report');
    expect(commands.find((c) => c.name === 'ship')?.hints).toEqual(['$1']);
  });

  it('project command overrides user command with the same name', async () => {
    await writeUserCommand('review', 'user version $ARGUMENTS');
    await writeProjectCommand('review', 'project version $ARGUMENTS');

    const commands = await service.listCommands(projectDir);
    const review = commands.filter((c) => c.name === 'review');
    expect(review.length).toBe(1);
    expect(review[0].template).toContain('project version');
  });

  it('registers MCP prompts as commands, file commands win on name clash', async () => {
    mcpMocks.getPrompts.mockReturnValue([
      { name: 'summarize', description: 'mcp summarizer', serverName: 'srv-a', arguments: [{ name: 'topic' }] },
      { name: 'daily', description: 'mcp daily', serverName: 'srv-b' },
    ]);
    await writeUserCommand('daily', 'file daily $ARGUMENTS');

    const commands = await service.listCommands(projectDir);
    const summarize = commands.find((c) => c.name === 'summarize');
    expect(summarize).toMatchObject({ source: 'mcp', description: 'mcp summarizer' });
    expect(summarize?.hints).toEqual(['$1']);

    const daily = commands.find((c) => c.name === 'daily');
    expect(daily?.source).toBe('file');
  });

  it('resolves a file command invocation into an expanded prompt with routing fields', async () => {
    await writeProjectCommand(
      'fix-issue',
      '---\ndescription: fix github issue\nagent: coder\nsubtask: true\n---\nFix issue $1.\nContext: $ARGUMENTS'
    );

    const resolved = await service.resolveInvocation('/fix-issue 123 high priority', projectDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.prompt).toContain('Fix issue 123.');
    expect(resolved!.prompt).toContain('Context: 123 high priority');
    expect(resolved!.agent).toBe('coder');
    expect(resolved!.subtask).toBe(true);
    expect(resolved!.source).toBe('file');
  });

  it('resolves an MCP prompt invocation by mapping positional args to prompt arguments', async () => {
    mcpMocks.getPrompts.mockReturnValue([
      { name: 'summarize', serverName: 'srv-a', arguments: [{ name: 'topic' }, { name: 'tone' }] },
    ]);
    mcpMocks.getPrompt.mockResolvedValue('Summarize TOPIC in TONE');

    const resolved = await service.resolveInvocation('/summarize quantum casual', projectDir);
    expect(resolved).not.toBeNull();
    expect(resolved!.prompt).toBe('Summarize TOPIC in TONE');
    expect(mcpMocks.getPrompt).toHaveBeenCalledWith('srv-a', 'summarize', {
      topic: 'quantum',
      tone: 'casual',
    });
  });

  it('returns null for unknown commands and plain messages', async () => {
    expect(await service.resolveInvocation('/nope args', projectDir)).toBeNull();
    expect(await service.resolveInvocation('plain message', projectDir)).toBeNull();
  });

  it('survives a missing commands directory', async () => {
    await fs.rm(path.join(projectDir, '.code-agent', 'commands'), { recursive: true, force: true });
    await fs.rm(path.join(userDir, 'commands'), { recursive: true, force: true });
    // 文件/MCP 来源为空时只剩 builtin 命令
    const commands = await service.listCommands(projectDir);
    expect(commands.filter((c) => c.source !== 'builtin')).toEqual([]);
  });

  it('applyPromptCommandExpansion rewrites envelope content and applies agent routing', async () => {
    await writeProjectCommand('triage', '---\nagent: debugger\n---\nTriage: $ARGUMENTS');
    const envelope = {
      content: '/triage login crash',
      sessionId: 's1',
      options: { mode: 'chat' },
    } as never;

    const expanded = await applyPromptCommandExpansion(envelope, projectDir);
    expect(expanded).not.toBe(envelope);
    expect((expanded as { content: string }).content).toBe('Triage: login crash');
    expect((expanded as { options: { agentOverrideId?: string; mode?: string } }).options).toMatchObject({
      mode: 'chat',
      agentOverrideId: 'debugger',
    });
  });

  it('applyPromptCommandExpansion passes through non-command and unknown-command envelopes', async () => {
    const plain = { content: 'hello', sessionId: 's1' } as never;
    expect(await applyPromptCommandExpansion(plain, projectDir)).toBe(plain);

    const unknown = { content: '/not-a-command x', sessionId: 's1' } as never;
    expect(await applyPromptCommandExpansion(unknown, projectDir)).toBe(unknown);
  });

  it('applyPromptCommandExpansion never throws on resolver failure', async () => {
    mcpMocks.getPrompts.mockImplementation(() => {
      throw new Error('mcp boom');
    });
    const envelope = { content: '/whatever x', sessionId: 's1' } as never;
    expect(await applyPromptCommandExpansion(envelope, projectDir)).toBe(envelope);
  });

  it('ignores non-md files and dotfiles in the commands directory', async () => {
    await fs.writeFile(path.join(projectDir, '.code-agent', 'commands', 'notes.txt'), 'x', 'utf-8');
    await fs.writeFile(path.join(projectDir, '.code-agent', 'commands', '.hidden.md'), 'x', 'utf-8');
    const commands = await service.listCommands(projectDir);
    expect(commands.filter((c) => c.source !== 'builtin')).toEqual([]);
  });

  // --------------------------------------------------------------------------
  // Builtin prompt commands (/init 等内置模板命令)
  // --------------------------------------------------------------------------
  describe('builtin commands', () => {
    it('exposes the builtin /init command even with empty command dirs', async () => {
      const commands = await service.listCommands(projectDir);
      const init = commands.find((c) => c.name === 'init');
      expect(init).toBeDefined();
      expect(init?.source).toBe('builtin');
      expect(init?.description).toBeTruthy();
      // 模板必须指示 agent 产出 CLAUDE.md
      expect(init?.template).toContain('CLAUDE.md');
    });

    it('resolves /init into the builtin analysis prompt', async () => {
      const resolved = await service.resolveInvocation('/init', projectDir);
      expect(resolved).not.toBeNull();
      expect(resolved!.source).toBe('builtin');
      expect(resolved!.prompt).toContain('CLAUDE.md');
    });

    it('lets a project file command override the builtin of the same name', async () => {
      await writeProjectCommand('init', 'project custom init $ARGUMENTS');
      const commands = await service.listCommands(projectDir);
      const matches = commands.filter((c) => c.name === 'init');
      expect(matches.length).toBe(1);
      expect(matches[0].source).toBe('file');
      expect(matches[0].template).toContain('project custom init');

      const resolved = await service.resolveInvocation('/init', projectDir);
      expect(resolved!.source).toBe('file');
    });

    it('lets a user file command override the builtin of the same name', async () => {
      await writeUserCommand('init', 'user custom init');
      const commands = await service.listCommands(projectDir);
      const matches = commands.filter((c) => c.name === 'init');
      expect(matches.length).toBe(1);
      expect(matches[0].source).toBe('file');
    });
  });
});
