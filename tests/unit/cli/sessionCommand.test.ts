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
    db.exec(`
      CREATE TABLE sessions (
        id TEXT PRIMARY KEY, title TEXT, model_provider TEXT, model_name TEXT,
        working_directory TEXT, status TEXT, created_at INTEGER, updated_at INTEGER
      );
      CREATE TABLE messages (id TEXT PRIMARY KEY, session_id TEXT);
    `);
    db.prepare(`INSERT INTO sessions VALUES ('session-1','title','p','m','/tmp','idle',1,2)`).run();
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
});
