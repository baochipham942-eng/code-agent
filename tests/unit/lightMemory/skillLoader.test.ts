// ============================================================================
// skillLoader tests (Workstream B)
// ============================================================================

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';

// Mock getUserConfigDir to point to a tmp directory
const tmpHomeBase = path.join(os.tmpdir(), 'skill-loader-test');
let tmpHome: string;

vi.mock('../../../src/main/config/configPaths', async () => {
  const actual = await vi.importActual<typeof import('../../../src/main/config/configPaths')>(
    '../../../src/main/config/configPaths',
  );
  return {
    ...actual,
    getUserConfigDir: () => tmpHome,
  };
});

const { loadRelevantSkills, buildSkillInjectionBlock } = await import(
  '../../../src/main/lightMemory/skillLoader'
);

// ----------------------------------------------------------------------------
// Helpers
// ----------------------------------------------------------------------------

async function writeSkill(
  filename: string,
  name: string,
  description: string,
  body: string,
): Promise<void> {
  const memDir = path.join(tmpHome, 'memory');
  await fs.mkdir(memDir, { recursive: true });
  const content = `---
name: ${name}
description: ${description}
type: skill
---

${body}`;
  await fs.writeFile(path.join(memDir, filename), content, 'utf-8');
}

async function writeNonSkill(filename: string, body: string): Promise<void> {
  const memDir = path.join(tmpHome, 'memory');
  await fs.mkdir(memDir, { recursive: true });
  const content = `---
name: irrelevant
description: should not be returned
type: feedback
---

${body}`;
  await fs.writeFile(path.join(memDir, filename), content, 'utf-8');
}

// ----------------------------------------------------------------------------
// Tests
// ----------------------------------------------------------------------------

describe('skillLoader', () => {
  beforeEach(async () => {
    tmpHome = path.join(tmpHomeBase, `test-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    await fs.mkdir(tmpHome, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpHome, { recursive: true, force: true });
  });

  it('returns empty when memory dir is missing', async () => {
    const result = await loadRelevantSkills('how to deploy');
    expect(result).toEqual([]);
  });

  it('returns empty when no skill_*.md files exist', async () => {
    await writeNonSkill('feedback_x.md', 'feedback content');
    const result = await loadRelevantSkills('how to deploy');
    expect(result).toEqual([]);
  });

  it('ignores non-skill memory files', async () => {
    await writeSkill(
      'skill_deploy.md',
      'Deploy',
      'Deploy with tauri build and sign',
      'steps...',
    );
    await writeNonSkill('feedback_deploy.md', 'deploy feedback');

    const result = await loadRelevantSkills('tauri deploy');
    expect(result.length).toBe(1);
    expect(result[0].filename).toBe('skill_deploy.md');
  });

  it('matches by keyword overlap with description and name', async () => {
    await writeSkill(
      'skill_deploy.md',
      'Deploy tauri app',
      'Bundle audio capture, sign, install. Keywords: tauri deploy release dmg',
      '1. npm run build\n2. cargo tauri build',
    );
    await writeSkill(
      'skill_eval.md',
      'Run evals',
      'Eval harness for mental agent. Keywords: eval mental benchmark',
      '1. Prepare data\n2. Run suite',
    );

    const deployResults = await loadRelevantSkills('I want to deploy the tauri app');
    expect(deployResults.length).toBe(1);
    expect(deployResults[0].filename).toBe('skill_deploy.md');

    const evalResults = await loadRelevantSkills('run evals on mental agent');
    expect(evalResults.length).toBe(1);
    expect(evalResults[0].filename).toBe('skill_eval.md');
  });

  it('ranks skills by match score', async () => {
    await writeSkill(
      'skill_a.md',
      'Skill A',
      'deploy',
      'body',
    );
    await writeSkill(
      'skill_b.md',
      'Skill B',
      'deploy tauri release dmg',
      'body',
    );

    const result = await loadRelevantSkills('deploy tauri release dmg bundle');
    expect(result.length).toBe(2);
    // skill_b has more keyword overlap → ranked first
    expect(result[0].filename).toBe('skill_b.md');
  });

  it('caps by SKILL_MAX_INJECTION_COUNT (default 3)', async () => {
    for (let i = 0; i < 8; i++) {
      await writeSkill(
        `skill_test_${i}.md`,
        `Test skill ${i}`,
        'deploy release dmg',
        'body',
      );
    }

    const result = await loadRelevantSkills('deploy release');
    expect(result.length).toBe(3);
  });

  it('returns empty for very short / empty queries', async () => {
    await writeSkill('skill_x.md', 'X', 'deploy', 'body');
    expect(await loadRelevantSkills('')).toEqual([]);
    expect(await loadRelevantSkills('a')).toEqual([]);
  });

  it('supports Chinese 3-char queries via CJK trigram', async () => {
    await writeSkill(
      'skill_feishu.md',
      '飞书机器人调试',
      '飞书机器人消息路由调试步骤',
      '1. 启动 ws server\n2. 转发消息',
    );
    await writeSkill(
      'skill_other.md',
      'Porsche 卡券审核',
      '保时捷卡券审核流程',
      '1. 查卡券\n2. 审核',
    );

    const result = await loadRelevantSkills('帮我调试飞书机器人的消息问题');
    expect(result.length).toBe(1);
    expect(result[0].filename).toBe('skill_feishu.md');
  });

  it('ignores malformed skill files', async () => {
    // No frontmatter → should be skipped
    const memDir = path.join(tmpHome, 'memory');
    await fs.mkdir(memDir, { recursive: true });
    await fs.writeFile(path.join(memDir, 'skill_broken.md'), 'no frontmatter here', 'utf-8');
    await writeSkill('skill_ok.md', 'OK', 'deploy release', 'body');

    const result = await loadRelevantSkills('deploy release');
    expect(result.length).toBe(1);
    expect(result[0].filename).toBe('skill_ok.md');
  });

  describe('buildSkillInjectionBlock', () => {
    it('returns null on empty input', () => {
      expect(buildSkillInjectionBlock([])).toBeNull();
    });

    it('wraps skills in <relevant_skills> XML block', () => {
      const block = buildSkillInjectionBlock([
        {
          filename: 'skill_x.md',
          name: 'X',
          description: 'desc',
          body: 'body content',
          matchScore: 2,
        },
      ]);
      expect(block).not.toBeNull();
      expect(block!).toContain('<relevant_skills>');
      expect(block!).toContain('### X');
      expect(block!).toContain('desc');
      expect(block!).toContain('body content');
      expect(block!).toContain('</relevant_skills>');
    });
  });
});
