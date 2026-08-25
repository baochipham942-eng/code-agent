import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import type { CanUseToolFn, Logger, ToolContext } from '../../../../../src/host/protocol/tools';

const atomicWriteState = vi.hoisted(() => ({
  blockedText: undefined as string | undefined,
  entered: undefined as (() => void) | undefined,
  release: undefined as Promise<void> | undefined,
}));

vi.mock('../../../../../src/host/services', () => ({
  getConfigService: () => ({ getApiKey: () => 'test-api-key' }),
}));

vi.mock('../../../../../src/host/tools/utils/atomicWrite', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../../../../src/host/tools/utils/atomicWrite')>();
  return {
    ...actual,
    atomicWriteFile: async (filePath: string, content: string) => {
      if (atomicWriteState.blockedText && content.includes(atomicWriteState.blockedText)) {
        atomicWriteState.entered?.();
        await atomicWriteState.release;
      }
      return actual.atomicWriteFile(filePath, content);
    },
  };
});

import { visualEditModule } from '../../../../../src/host/tools/modules/vision/visualEdit';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(workingDir: string, overrides: Partial<ToolContext> = {}): ToolContext {
  return {
    sessionId: 'test-session',
    agentId: 'test-agent',
    workingDir,
    abortSignal: new AbortController().signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });

describe('visualEditModule concurrency', () => {
  let tmpDir: string;
  let file: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'visual-edit-lock-'));
    file = path.join(tmpDir, 'Component.tsx');
    await fs.writeFile(file, 'const alpha = 0;\nconst beta = 0;\n', 'utf-8');
    atomicWriteState.blockedText = undefined;
    atomicWriteState.entered = undefined;
    atomicWriteState.release = undefined;
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: RequestInit) => {
      const body = JSON.parse(String(init.body)) as { messages: Array<{ content: unknown }> };
      const userContent = JSON.stringify(body.messages[1]?.content);
      const plan = userContent.includes('alpha intent')
        ? { old_text: 'const alpha = 0;', new_text: 'const alpha = 1;', summary: 'alpha' }
        : { old_text: 'const beta = 0;', new_text: 'const beta = 1;', summary: 'beta' };
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: JSON.stringify(plan) } }] }),
      } as Response;
    }));
  });

  afterEach(async () => {
    vi.unstubAllGlobals();
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  async function run(userIntent: string, agentId: string) {
    const handler = await visualEditModule.createHandler();
    return handler.execute(
      { file, line: 1, userIntent },
      makeCtx(tmpDir, { agentId }),
      allowAll,
    );
  }

  it('serializes sibling agents and revalidates each plan against the latest file', async () => {
    let releaseFirst!: () => void;
    let markFirstEntered!: () => void;
    const firstEntered = new Promise<void>((resolve) => { markFirstEntered = resolve; });
    atomicWriteState.blockedText = 'const alpha = 1;';
    atomicWriteState.entered = markFirstEntered;
    atomicWriteState.release = new Promise<void>((resolve) => { releaseFirst = resolve; });

    try {
      const first = run('alpha intent', 'agent-a');
      await firstEntered;
      let secondSettled = false;
      const second = run('beta intent', 'agent-b').finally(() => { secondSettled = true; });
      await new Promise((resolve) => setTimeout(resolve, 25));
      expect(secondSettled).toBe(false);

      releaseFirst();
      expect((await first).ok).toBe(true);
      expect((await second).ok).toBe(true);
      expect(await fs.readFile(file, 'utf-8')).toBe('const alpha = 1;\nconst beta = 1;\n');
    } finally {
      releaseFirst();
    }
  });

  it('fails loudly when agent identity is unavailable', async () => {
    const handler = await visualEditModule.createHandler();
    const result = await handler.execute(
      { file, line: 1, userIntent: 'alpha intent' },
      makeCtx(tmpDir, { agentId: undefined }),
      allowAll,
    );
    expect(result.ok).toBe(false);
    if (!result.ok) expect(result.code).toBe('MISSING_AGENT_IDENTITY');
  });
});
