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
} from '../../../../../src/host/protocol/tools';

const mockConfigDir = vi.hoisted(() => ({ dir: '' }));

vi.mock('../../../../../src/host/config/configPaths', () => ({
  getUserConfigDir: () => mockConfigDir.dir,
}));

vi.mock('../../../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

import { memoryReadModule } from '../../../../../src/host/tools/modules/lightMemory/memoryRead';
import {
  getRoleMemoriesDir,
  getProjectMemoriesDir,
} from '../../../../../src/host/services/roleAssets/roleAssetPaths';

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
        expect(result.meta).toMatchObject({
          filename: 'user_role.md',
          bytes: content.length,
        });
        const artifact = result.meta?.artifact as { kind?: string; path?: string; mimeType?: string; metadata?: Record<string, unknown> };
        expect(artifact.kind).toBe('text');
        expect(artifact.mimeType).toBe('text/markdown');
        expect(artifact.path).toBe(path.join(memDir, 'user_role.md'));
        expect(artifact.metadata?.filename).toBe('user_role.md');
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

  describe('status footnote (candidate/stale)', () => {
    // 与 src/host/tools/modules/lightMemory/memoryRead.ts 的 MEMORY_UNVERIFIED_HINT 同字节；
    // 断言落在提示行本身，改文案必须同步这里。
    const HINT = '⚠️ 此记忆状态为 candidate/stale：未经确认或可能已过时，作为事实使用前请先核对当前状态。';

    const candidateContent = `---
name: Trial Note
description: Unverified candidate memory
type: project
status: candidate
---

The deploy command might have changed since this was captured.
`;

    const staleContent = `---
name: Old Runbook
description: Possibly outdated runbook
type: project
status: stale
---

The service used to run on port 3000.
`;

    it('appends the unverified hint line for status candidate', async () => {
      await fs.writeFile(path.join(memDir, 'candidate_note.md'), candidateContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'candidate_note.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(`${candidateContent}${HINT}\n`);
      }
    });

    it('appends the unverified hint line for status stale', async () => {
      await fs.writeFile(path.join(memDir, 'stale_note.md'), staleContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'stale_note.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(`${staleContent}${HINT}\n`);
      }
    });

    it('keeps active memory output byte-identical to the raw content', async () => {
      const activeContent = `---
name: Confirmed Note
description: Verified memory
type: user
status: active
---

Confirmed fact that was double-checked.
`;
      await fs.writeFile(path.join(memDir, 'active_note.md'), activeContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'active_note.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(activeContent);
      }
    });

    it('keeps output byte-identical for a file without frontmatter', async () => {
      const plainContent = 'plain note without any frontmatter\n';
      await fs.writeFile(path.join(memDir, 'plain_note.md'), plainContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'plain_note.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(plainContent);
      }
    });

    it('does not add the hint for rejected status', async () => {
      const rejectedContent = `---
name: Rejected Note
description: Rejected memory
type: user
status: rejected
---

Content that was rejected.
`;
      await fs.writeFile(path.join(memDir, 'rejected_note.md'), rejectedContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'rejected_note.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(rejectedContent);
      }
    });

    it('appends the hint for candidate memory in role scope', async () => {
      const roleDir = getRoleMemoriesDir('trial-role');
      await fs.mkdir(roleDir, { recursive: true });
      await fs.writeFile(path.join(roleDir, 'role_candidate.md'), candidateContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'role_candidate.md', scope: 'role' },
        makeCtx({ subagent: { agentRole: 'trial-role' } }),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(`${candidateContent}${HINT}\n`);
        expect(result.meta).toMatchObject({ scope: 'role' });
      }
    });

    it('appends the hint for candidate memory in project scope', async () => {
      const workingDir = process.cwd();
      const projectDir = getProjectMemoriesDir(workingDir);
      await fs.mkdir(projectDir, { recursive: true });
      await fs.writeFile(path.join(projectDir, 'project_candidate.md'), candidateContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'project_candidate.md', scope: 'project' },
        makeCtx({ workingDir }),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).toBe(`${candidateContent}${HINT}\n`);
        expect(result.meta).toMatchObject({ scope: 'project' });
      }
    });

    it('applies sensitive-data guarding before appending the hint', async () => {
      const sensitiveContent = `---
name: Contact Note
description: Contains contact info
type: user
status: candidate
---

Reach the on-call engineer at ops@example.com when this breaks.
`;
      await fs.writeFile(path.join(memDir, 'contact_note.md'), sensitiveContent, 'utf-8');

      const handler = await memoryReadModule.createHandler();
      const result = await handler.execute(
        { filename: 'contact_note.md' },
        makeCtx(),
        allowAll,
      );
      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.output).not.toContain('ops@example.com');
        expect(result.output).toContain('[email hidden]');
        expect(result.output.endsWith(`${HINT}\n`)).toBe(true);
        // 提示行在脱敏之后追加：脱敏产物仍在提示行之前
        expect(result.output.indexOf('[email hidden]')).toBeLessThan(result.output.indexOf(HINT));
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
