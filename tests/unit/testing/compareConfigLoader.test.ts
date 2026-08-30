import { afterEach, describe, expect, it } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { loadCompareConfig } from '../../../src/host/testing/comparator/configLoader';

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('loadCompareConfig unified arm schema', () => {
  it('parses all harness, memory, reasoning and reserved skills fields', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-config-'));
    tempDirs.push(dir);
    const file = path.join(dir, 'candidate.yaml');
    await writeFile(file, [
      'name: candidate',
      'harness:',
      '  contextCompression: false',
      '  compressionPipeline: false',
      '  scaffoldProfile: true',
      '  thinkingInjection: false',
      '  hooksEnabled: true',
      '  toolMode: all',
      'memory:',
      '  longTerm: true',
      '  routingModel: memory-model',
      'reasoningEffort: xhigh',
      'skills: [docx]',
      '',
    ].join('\n'));

    await expect(loadCompareConfig(file, { discoverableSkillNames: ['docx'] })).resolves.toMatchObject({
      name: 'candidate',
      harness: {
        name: 'candidate',
        contextCompression: false,
        compressionPipeline: false,
        scaffoldProfile: true,
        thinkingInjection: false,
        hooksEnabled: true,
        toolMode: 'all',
      },
      memory: { longTerm: true, routingModel: 'memory-model' },
      reasoningEffort: 'xhigh',
      skills: ['docx'],
    });
  });

  it('sorts/deduplicates discoverable skills and rejects a missing capability', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-config-'));
    tempDirs.push(dir);
    const valid = path.join(dir, 'valid.yaml');
    const missing = path.join(dir, 'missing.yaml');
    await writeFile(valid, 'name: candidate\nskills: [xlsx, docx, xlsx]\n');
    await writeFile(missing, 'name: candidate\nskills: [missing-skill]\n');

    await expect(loadCompareConfig(valid, { discoverableSkillNames: ['docx', 'xlsx'] }))
      .resolves.toMatchObject({ skills: ['docx', 'xlsx'] });
    await expect(loadCompareConfig(missing, { discoverableSkillNames: ['docx', 'xlsx'] }))
      .rejects.toThrow('实验组指定的能力 missing-skill 不存在');
  });

  it('rejects invalid reasoning effort and harness enum values', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'compare-config-'));
    tempDirs.push(dir);
    const effort = path.join(dir, 'effort.yaml');
    const toolMode = path.join(dir, 'tool-mode.yaml');
    await writeFile(effort, 'name: candidate\nreasoningEffort: ultra\n');
    await writeFile(toolMode, 'name: candidate\nharness:\n  toolMode: hidden\n');

    await expect(loadCompareConfig(effort)).rejects.toThrow(/reasoningEffort.*low, medium, high, xhigh/);
    await expect(loadCompareConfig(toolMode)).rejects.toThrow(/harness\.toolMode.*all, deferred/);
  });
});
