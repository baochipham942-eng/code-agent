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

    await expect(loadCompareConfig(file)).resolves.toMatchObject({
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
