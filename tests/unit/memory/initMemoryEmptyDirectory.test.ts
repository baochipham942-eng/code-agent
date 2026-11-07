import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type { CanUseToolFn, Logger, ToolContext } from '../../../src/host/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));
vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }),
}));
vi.mock('../../../src/host/services/core/databaseService', () => ({
  getDatabase: () => ({
    listMemories: () => {
      throw new Error('Database not initialized');
    },
  }),
}));

import { BUILTIN_PROMPT_COMMANDS } from '../../../src/shared/commands/builtinPromptCommands';
import { proposeProjectMemoryModule } from '../../../src/host/tools/modules/lightMemory/proposeProjectMemory';

const allow: CanUseToolFn = async () => ({ allow: true });

function toolContext(workingDir: string): ToolContext {
  const logger: Logger = { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
  return { sessionId: 'empty-dir-test', workingDir, abortSignal: new AbortController().signal, logger } as ToolContext;
}

describe('/init-memory on an empty project (N-INIT-PROJECT-MEMORY-REST2)', () => {
  it('template tells the agent not to propose anything when the directory is empty', () => {
    const template = BUILTIN_PROMPT_COMMANDS.find((item) => item.name === 'init-memory')?.template ?? '';
    expect(template).toContain(
      '目录不存在、为空、或一个文件都读不了时：直接说明这一点，不要调用 ProposeProjectMemory。',
    );
    expect(template).toContain('空目录或读不到文件时说明没有写入');
  });

  describe('ProposeProjectMemory output status', () => {
    let configDir: string;
    let projectDir: string;

    beforeEach(async () => {
      configDir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-empty-neo-'));
      projectDir = await fs.mkdtemp(path.join(os.tmpdir(), 'init-empty-src-'));
      mockConfigDir.dir = configDir;
      await fs.writeFile(path.join(projectDir, 'notes.md'), 'Household expense notes.\n', 'utf8');
    });

    afterEach(async () => {
      await fs.rm(configDir, { recursive: true, force: true });
      await fs.rm(projectDir, { recursive: true, force: true });
    });

    it('every topic only ever yields status: candidate, never active', async () => {
      const handler = await proposeProjectMemoryModule.createHandler();
      for (const topic of ['purpose', 'key-files', 'conventions']) {
        const result = await handler.execute(
          { topic, summary: `s ${topic}`, content: `c ${topic}`, sources: ['notes.md'] },
          toolContext(projectDir),
          allow,
        );
        expect(result.ok).toBe(true);
        if (result.ok) expect(result.meta).toMatchObject({ outcome: 'written', status: 'candidate' });
      }
      const files = (await fs.readdir(path.join(configDir, 'memory'))).filter((f) => f.startsWith('initmem-'));
      expect(files).toHaveLength(3);
      for (const file of files) {
        const raw = await fs.readFile(path.join(configDir, 'memory', file), 'utf8');
        expect(raw).toMatch(/^status: candidate$/m);
        expect(raw).not.toMatch(/^status: active$/m);
      }
    });
  });
});
