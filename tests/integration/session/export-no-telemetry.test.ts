import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.unmock('better-sqlite3');
import Database from 'better-sqlite3';
import JSZip from 'jszip';
import { applySchema } from '../../../src/host/services/core/database/schema';
import { getDatabase } from '../../../src/host/services/core/databaseService';
import { SessionRepository } from '../../../src/host/services/core/repositories/SessionRepository';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { buildSessionPackage, buildSessionTranscriptJsonl } from '../../../src/host/session/spine/packageBuilder';
import type { Message } from '../../../src/shared/contract/message';

const SID = 'session-export-v2-12345678';
const DAY_ONE = Date.parse('2026-01-01T23:59:00.000Z');
const DAY_TWO = Date.parse('2026-01-02T00:01:00.000Z');

function logger() {
  return { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() };
}

describe('session export package v2', () => {
  let db: Database.Database;
  let tempDir: string;
  let originalGetDb: () => Database.Database | null;
  let readySpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    db = new Database(':memory:');
    applySchema(db, logger() as never);
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-export-v2-'));
    const database = getDatabase();
    originalGetDb = database.getDb.bind(database);
    readySpy = vi.spyOn(database, 'isReady', 'get').mockReturnValue(true);
    database.getDb = () => db;
    db.prepare(`
      INSERT INTO sessions (id, title, model_provider, model_name, working_directory, created_at, updated_at)
      VALUES (?, ?, 'openai', 'gpt-test', ?, ?, ?)
    `).run(SID, 'private export', '/Users/tester/project', DAY_ONE, DAY_TWO);
  });

  afterEach(() => {
    const database = getDatabase();
    database.getDb = originalGetDb;
    readySpy.mockRestore();
    db.close();
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  function addMessages(count: number, content = 'hello'): void {
    const repository = new SessionRepository(db);
    for (let index = 0; index < count; index += 1) {
      repository.addMessage(SID, {
        id: `message-${index}`,
        role: index % 2 === 0 ? 'user' : 'assistant',
        content: `${content} ${index}`,
        timestamp: DAY_ONE + index * 100,
        metadata: { correlation: { turnId: `turn-${Math.floor(index / 2)}`, traceId: 'trace-export' } },
      } as Message, { skipTimestampUpdate: true });
    }
  }

  it('T-no-telemetry: authoritative messages remain complete and telemetry bundle is absent', async () => {
    addMessages(3);
    const result = await buildSessionPackage(SID, {
      db,
      storage: new TelemetryStorage(),
      builtAt: DAY_TWO,
      logDir: path.join(tempDir, 'logs'),
      auditDir: path.join(tempDir, 'audit'),
      homeDir: '/Users/tester',
    });

    expect(result.manifest.packageVersion).toBe(2);
    expect(result.manifest.source.hadTelemetrySession).toBe(false);
    expect(result.manifest.includes.telemetryBundle).toBe(false);
    expect(result.manifest.stats.messageCount).toBe(3);
    expect(result.files.has('telemetry/bundle.sanitized.json')).toBe(false);
    expect(result.files.get('transcript.jsonl')!.toString('utf8').match(/"type":"message"/g)).toHaveLength(3);
    expect(buildSessionTranscriptJsonl(SID, { db }).match(/"type":"message"/g)).toHaveLength(3);
    const zip = await JSZip.loadAsync(result.buffer);
    expect(Object.keys(zip.files)).toContain('transcript.jsonl');
    // 短片段取 sessionId 尾部：前 8 位对 `session_*` 家族毫无区分度，会让两次导出互相覆盖。
    expect(result.suggestedFileName).toMatch(/^neo-session-12345678-\d{8}-\d{6}\.zip$/);
  });

  it('T-privacy: shareable package scrubs credentials and home paths across messages and audit', async () => {
    const secret = 'api_key=supersecret123456';
    addMessages(1, `${secret} /Users/tester/private/file.txt token=tokenvalue123456`);
    const auditDir = path.join(tempDir, 'audit');
    fs.mkdirSync(auditDir, { recursive: true });
    fs.writeFileSync(path.join(auditDir, '2026-01-01.jsonl'), `${JSON.stringify({
      timestamp: DAY_ONE,
      sessionId: SID,
      eventType: 'command_execution',
      input: { command: `cat /Users/tester/private && ${secret}` },
      output: 'token=tokenvalue123456',
    })}\n`);

    const result = await buildSessionPackage(SID, {
      db,
      storage: new TelemetryStorage(),
      builtAt: DAY_TWO,
      logDir: path.join(tempDir, 'logs'),
      auditDir,
      homeDir: '/Users/tester',
      privacyLevel: 'shareable',
    });
    const allText = [...result.files.values()].map((buffer) => buffer.toString('utf8')).join('\n');
    expect(allText).not.toContain('supersecret123456');
    expect(allText).not.toContain('tokenvalue123456');
    expect(allText).not.toContain('/Users/tester');
    expect(result.files.get('audit.jsonl')!.toString('utf8')).toContain('[REDACTED]');
  });

  it('T-window: reads both daily files and excludes rows outside the session window or another session', async () => {
    addMessages(2);
    const logDir = path.join(tempDir, 'logs');
    fs.mkdirSync(logDir, { recursive: true });
    fs.writeFileSync(path.join(logDir, 'code-agent-2026-01-01.log'), [
      JSON.stringify({ timestamp: new Date(DAY_ONE).toISOString(), sessionId: SID, message: 'day-one' }),
      JSON.stringify({ timestamp: new Date(DAY_ONE).toISOString(), sessionId: 'other', message: 'wrong-session' }),
    ].join('\n'));
    fs.writeFileSync(path.join(logDir, 'code-agent-2026-01-02.log'), [
      JSON.stringify({ timestamp: new Date(DAY_TWO).toISOString(), sessionId: SID, message: 'day-two' }),
      JSON.stringify({ timestamp: new Date(DAY_TWO).toISOString(), context: 'startup', message: 'weak-row' }),
      JSON.stringify({ timestamp: new Date(DAY_TWO + 3_600_000).toISOString(), sessionId: SID, message: 'too-late' }),
    ].join('\n'));

    const result = await buildSessionPackage(SID, {
      db,
      storage: new TelemetryStorage(),
      builtAt: DAY_TWO,
      logDir,
      auditDir: path.join(tempDir, 'audit'),
    });
    const logs = result.files.get('logs/window.jsonl')!.toString('utf8');
    expect(logs).toContain('day-one');
    expect(logs).toContain('day-two');
    expect(logs).toContain('"confidence":"weak"');
    expect(logs).not.toContain('wrong-session');
    expect(logs).not.toContain('too-late');
  });

  it('1000 messages export completes within 15 seconds', async () => {
    addMessages(1000);
    const started = performance.now();
    const result = await buildSessionPackage(SID, {
      db,
      storage: new TelemetryStorage(),
      builtAt: DAY_TWO,
      logDir: path.join(tempDir, 'logs'),
      auditDir: path.join(tempDir, 'audit'),
    });
    const elapsed = performance.now() - started;
    expect(result.manifest.stats.messageCount).toBe(1000);
    expect(elapsed).toBeLessThan(15_000);
  });
});
