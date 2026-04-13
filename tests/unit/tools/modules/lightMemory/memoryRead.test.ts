// ============================================================================
// MemoryRead (native ToolModule) Tests
// Tests reading memory files, validation, canUseTool gate, ctx wiring
// ============================================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs/promises';
import * as path from 'path';
import os from 'os';
import type {
  ToolContext,
  CanUseToolFn,
  Logger,
} from '../../../../../src/main/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../../src/main/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../../../src/main/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { memoryReadModule } from '../../../../../src/main/tools/modules/lightMemory/memoryRead';

function makeLogger(): Logger {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

function makeCtx(overrides: Partial<ToolContext> = {}): ToolContext {
  const ctrl = new AbortController();
  return {
    sessionId: 'test-session',
    workingDir: process.cwd(),
    abortSignal: ctrl.signal,
    logger: makeLogger(),
    emit: () => void 0,
    ...overrides,
  };
}

const allowAll: CanUseToolFn = async () => ({ allow: true });
const denyAll: CanUseToolFn = async () => ({ allow: false, reason: 'blocked' });

describe('memoryReadModule (native)', () => {
  let tmpDir: string;
  let memDir: string;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'lm-read-native-'));
    mockConfigDir.dir = tmpDir;
    memDir = path.join(tmpDir, 'memory');
    await fs.mkdir(memDir, { recursive: true });
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  describe('schema', () => {
    it('has correct name and readOnly metadata', () => {
      expect(memoryReadModule.schema.name).toBe('MemoryRead');
      expect(memoryReadModule.schema.readOnly).toBe(true);
      expect(memoryReadModule.schema.allowInPlanMode).toBe(true);
      expect(memoryReadModule.schema.permissionLevel).toBe('read');
      expect(memoryReadModule.schema.inputSchema.required).toContain('filename');
    });
  });

  describe('validation', () => {
    it('rejects filename not ending with .md', async () => {
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute({ filename: 'test.json' }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('.md');
    });

    it('rejects path traversal attempts', async () => {
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: '../../etc/passwd.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('path separators');
    });

    it('rejects absolute path in filename', async () => {
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute({ filename: '/tmp/secret.md' }, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.error).toContain('path separators');
    });

    it('rejects missing filename', async () => {
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute({}, makeCtx(), allowAll);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('INVALID_ARGS');
    });
  });

  describe('canUseTool gate', () => {
    it('returns PERMISSION_DENIED when canUseTool denies', async () => {
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'any.md' },
        makeCtx(),
        denyAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('PERMISSION_DENIED');
    });

    it('returns ABORTED when abortSignal fired', async () => {
      const ctrl = new AbortController();
      ctrl.abort();
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'any.md' },
        makeCtx({ abortSignal: ctrl.signal }),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe('ABORTED');
    });
  });

  describe('reading files', () => {
    it('reads an existing memory file', async () => {
      const content = `---
name: User Role
description: User background info
type: user
---

Product Manager with 14 years of experience.
`;
      await fs.writeFile(path.join(memDir, 'user_role.md'), content, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'user_role.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('Product Manager');
        expect(result.output).toContain('name: User Role');
      }
    });

    it('returns ENOENT for non-existent file', async () => {
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'nonexistent.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toContain('not found');
        expect(result.error).toContain('nonexistent.md');
        expect(result.code).toBe('ENOENT');
      }
    });

    it('reads file with complex markdown content', async () => {
      const content = `---
name: Project Notes
description: Notes about the project
type: project
---

## Architecture
- Layer 1: Core
- Layer 2: Skills

\`\`\`typescript
const x = 42;
\`\`\`
`;
      await fs.writeFile(path.join(memDir, 'project_notes.md'), content, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'project_notes.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toContain('## Architecture');
        expect(result.output).toContain('const x = 42');
      }
    });
  });

  describe('progress events', () => {
    it('emits starting and completing stages on success', async () => {
      await fs.writeFile(path.join(memDir, 'ok.md'), 'hello', 'utf-8');
      const events: string[] = [];
      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'ok.md' },
        makeCtx(),
        allowAll,
        (p) => events.push(p.stage),
      );
      expect(result.ok).toBe(true);
      expect(events).toContain('starting');
      expect(events).toContain('completing');
    });
  });
});
