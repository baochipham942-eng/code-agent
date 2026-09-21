import fs from 'fs';
import os from 'os';
import path from 'path';
import Module from 'module';
import { Command } from 'commander';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  buildSessionTranscriptJsonl: vi.fn(),
  buildSessionPackage: vi.fn(),
}));

vi.mock('../../../src/cli/sessionDiagnostics/sessionPackageAdapter', () => ({
  loadSessionPackageBuilder: async () => mocks,
}));

import { applyTestSessionSchema } from '../../utils/applyTestSessionSchema';
import { buildSessionExportEnvelopeV2 } from '../../../src/host/services/sessionFork/portability/codec';

const testRequire = Module.createRequire(import.meta.url);
const NativeDatabase = testRequire('better-sqlite3') as typeof import('better-sqlite3');

describe('session export command', () => {
  let root: string;
  let outputDir: string;
  let rejectedWrite = false;
  const originalDataDir = process.env.CODE_AGENT_DATA_DIR;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-session-export-cli-'));
    outputDir = path.join(root, 'out');
    process.env.CODE_AGENT_DATA_DIR = root;
    const db = new NativeDatabase(path.join(root, 'code-agent.db'));
    applyTestSessionSchema(db);
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, working_directory, status, created_at, updated_at)
      VALUES ('session-1','title','p','m','/tmp','idle',1,2)
    `).run();
    db.close();
    rejectedWrite = false;
    mocks.buildSessionTranscriptJsonl.mockReset().mockImplementation((
      _sessionId: string,
      options: { db: import('better-sqlite3').Database },
    ) => {
      try {
        options.db.prepare(`INSERT INTO sessions (id) VALUES ('blocked')`).run();
      } catch (error) {
        rejectedWrite = /readonly|read-only/i.test(error instanceof Error ? error.message : String(error));
      }
      return '{"v":1}\n';
    });
    mocks.buildSessionPackage.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
    if (originalDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = originalDataDir;
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('delegates --jsonl to Slice B and passes a query-only database', async () => {
    vi.doUnmock('better-sqlite3');
    const { sessionCommand } = await import('../../../src/cli/commands/session');
    (sessionCommand as unknown as { parent?: Command }).parent = undefined;
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    const program = new Command().exitOverride().addCommand(sessionCommand);
    await program.parseAsync([
      'node', 'neo', 'session', 'export', 'session-1', '--jsonl',
      '--privacy', 'shareable', '--out', outputDir,
    ]);

    expect(mocks.buildSessionTranscriptJsonl).toHaveBeenCalledOnce();
    const [, options] = mocks.buildSessionTranscriptJsonl.mock.calls[0] as [
      string,
      { db: import('better-sqlite3').Database; privacyLevel: string },
    ];
    expect(options.privacyLevel).toBe('shareable');
    expect(rejectedWrite).toBe(true);
    const outputPath = stdout.join('').trim();
    expect(path.dirname(outputPath)).toBe(outputDir);
    expect(fs.readFileSync(outputPath, 'utf8')).toBe('{"v":1}\n');
    expect(fs.statSync(outputPath).mode & 0o777).toBe(0o600);
  });

  it('plans session import in dry-run mode without opening a writable database', async () => {
    const envelope = buildSessionExportEnvelopeV2({
      exportId: 'export-1',
      exportedAt: 10,
      ownerScopeId: 'owner-a',
      projectId: 'project-a',
      rootSessionId: 'session-a',
      mode: 'subtree',
      sessions: [{
        session: {
          id: 'session-a', userId: 'owner-a', projectId: 'project-a', title: 'Imported',
          modelConfig: { provider: 'openai', model: 'test-model' }, createdAt: 1, updatedAt: 2,
        },
        messages: [
          { id: 'message-a', role: 'user', content: 'hello', timestamp: 1 },
          { id: 'message-b', role: 'assistant', content: 'world', timestamp: 2 },
        ],
      }],
    });
    const envelopePath = path.join(root, 'export.json');
    fs.writeFileSync(envelopePath, JSON.stringify(envelope));

    vi.doUnmock('better-sqlite3');
    const { sessionCommand } = await import('../../../src/cli/commands/session');
    (sessionCommand as unknown as { parent?: Command }).parent = undefined;
    const stdout: string[] = [];
    vi.spyOn(process.stdout, 'write').mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as never);
    const program = new Command().exitOverride().addCommand(sessionCommand);
    await program.parseAsync([
      'node', 'neo', 'session', 'import', envelopePath,
      '--dry-run', '--owner', 'owner-a', '--project', 'project-a', '--namespace', 'cli-test', '--json',
    ]);

    const result = JSON.parse(stdout.join('')) as Record<string, unknown>;
    expect(result).toMatchObject({
      dryRun: true,
      sourceExportId: 'export-1',
      targetOwnerScopeId: 'owner-a',
      targetProjectId: 'project-a',
      sessionCount: 1,
      messageCount: 2,
      lineageNodeCount: 1,
    });
    expect(fs.existsSync(path.join(root, 'blocked'))).toBe(false);
  });
});
