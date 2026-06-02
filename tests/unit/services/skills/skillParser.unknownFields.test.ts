// ============================================================================
// 未知配置字段告警测试 (GAP-007)
// ============================================================================
//
// 验证拼写错误/未知的配置字段不会被静默忽略：
// - Skill frontmatter 未知字段 → console.warn + ParsedSkill.frontmatterWarnings
// - Hooks 配置未知事件名 / 无效 hook 定义 → console.warn
//
// 课程依据：《Claude Code 工程化实战》第 05 讲评论区
// "permissionMode: plan 被静默忽略 = 用户以为加了护栏其实没有"

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { parseSkillMd, parseSkillMetadataOnly } from '../../../../src/main/services/skills/skillParser';

describe('Skill frontmatter unknown field warnings (GAP-007)', () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'skill-parser-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function writeSkill(frontmatter: string): string {
    const content = `---\n${frontmatter}\n---\n\nSkill body content.\n`;
    fs.writeFileSync(path.join(tempDir, 'SKILL.md'), content, 'utf-8');
    return tempDir;
  }

  it('warns on typo field with spelling suggestion (alowed-tools → allowed-tools)', async () => {
    const dir = writeSkill([
      'name: test-skill',
      'description: A test skill',
      'alowed-tools: [Read, Grep]', // typo: 缺一个 l
    ].join('\n'));

    const skill = await parseSkillMd(dir, 'user');

    // 拼写错误的字段被忽略 → allowedTools 为空（这正是危险所在）
    expect(skill.allowedTools).toEqual([]);
    // 但必须有告警
    expect(skill.frontmatterWarnings).toBeDefined();
    expect(skill.frontmatterWarnings![0]).toContain('alowed-tools');
    expect(skill.frontmatterWarnings![0]).toContain('allowed-tools'); // 拼写建议
    expect(warnSpy).toHaveBeenCalled();
  });

  it('warns on completely unknown field without suggestion', async () => {
    const dir = writeSkill([
      'name: test-skill',
      'description: A test skill',
      'totally-made-up-field: hello',
    ].join('\n'));

    const skill = await parseSkillMd(dir, 'user');

    expect(skill.frontmatterWarnings).toBeDefined();
    expect(skill.frontmatterWarnings![0]).toContain('totally-made-up-field');
  });

  it('no warnings for valid frontmatter', async () => {
    const dir = writeSkill([
      'name: test-skill',
      'description: A test skill',
      'allowed-tools: [Read, Grep]',
      'disable-model-invocation: true',
      'context: fork',
    ].join('\n'));

    const skill = await parseSkillMd(dir, 'user');

    expect(skill.frontmatterWarnings).toBeUndefined();
    expect(warnSpy).not.toHaveBeenCalled();
  });

  it('parseSkillMetadataOnly also reports warnings', async () => {
    const dir = writeSkill([
      'name: test-skill',
      'description: A test skill',
      'permissionMode: plan', // 课程点名的非法字段案例
    ].join('\n'));

    const skill = await parseSkillMetadataOnly(dir, 'user');

    expect(skill.frontmatterWarnings).toBeDefined();
    expect(skill.frontmatterWarnings![0]).toContain('permissionMode');
  });
});

describe('Hooks config unknown event/field warnings (GAP-007)', () => {
  let tempDir: string;
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hooks-parser-test-'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function parseHooksJson(config: Record<string, unknown>): Promise<void> {
    const hooksDir = path.join(tempDir, '.code-agent', 'hooks');
    fs.mkdirSync(hooksDir, { recursive: true });
    const hooksJsonPath = path.join(hooksDir, 'hooks.json');
    fs.writeFileSync(hooksJsonPath, JSON.stringify(config), 'utf-8');

    const { parseHooksConfig } = await import('../../../../src/main/hooks/configParser');
    await parseHooksConfig(hooksJsonPath, 'project', 'hooks-json');
  }

  it('warns on wrong-case event name with suggestion', async () => {
    await parseHooksJson({
      // 错误大小写：preToolUse 而不是 PreToolUse
      preToolUse: [
        { matcher: '*', hooks: [{ type: 'command', command: 'echo hi' }] },
      ],
    });

    const warnings = warnSpy.mock.calls.map(args => String(args[0]));
    const eventWarning = warnings.find(w => w.includes('preToolUse'));
    expect(eventWarning).toBeDefined();
    expect(eventWarning).toContain('PreToolUse'); // 大小写建议
  });

  it('warns when hook is dropped due to invalid type', async () => {
    await parseHooksJson({
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'shell', command: 'echo hi' }] }, // 'shell' 不是合法 type
      ],
    });

    const warnings = warnSpy.mock.calls.map(args => String(args[0]));
    expect(warnings.some(w => w.includes('invalid type'))).toBe(true);
  });

  it('warns when command hook is missing command field', async () => {
    await parseHooksJson({
      PreToolUse: [
        { matcher: '*', hooks: [{ type: 'command' }] }, // 缺 command
      ],
    });

    const warnings = warnSpy.mock.calls.map(args => String(args[0]));
    expect(warnings.some(w => w.includes('missing "command" field'))).toBe(true);
  });

  it('warns on unknown field inside hook definition', async () => {
    await parseHooksJson({
      PreToolUse: [
        {
          matcher: '*',
          hooks: [{ type: 'command', command: 'echo hi', timout: 5000 }], // typo: timout
        },
      ],
    });

    const warnings = warnSpy.mock.calls.map(args => String(args[0]));
    expect(warnings.some(w => w.includes('timout'))).toBe(true);
  });
});
