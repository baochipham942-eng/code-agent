import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { renderSkillContent } from '../../../../src/main/services/skills/skillRenderer';

describe('skillRenderer', () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'skill-renderer-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('replaces $ARGUMENTS without executing !cmd shell lines', async () => {
    const pwned = path.join(tmpDir, 'skill-pwned');
    const rendered = renderSkillContent(
      [
        'Use args: $ARGUMENTS',
        `!touch ${pwned}`,
      ].join('\n'),
      { arguments: 'hello world', workingDirectory: tmpDir },
    );

    expect(rendered).toContain('Use args: hello world');
    expect(rendered).toContain(`[Skill shell command blocked: touch ${pwned}]`);
    await expect(fs.access(pwned)).rejects.toThrow();
  });

  it('removes $ARGUMENTS when no arguments are provided', () => {
    expect(renderSkillContent('Args: $ARGUMENTS')).toBe('Args: ');
  });
});
