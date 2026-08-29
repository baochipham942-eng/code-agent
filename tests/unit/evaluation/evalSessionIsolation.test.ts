import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll, afterEach, describe, expect, it, vi } from 'vitest';

const originalCliMode = vi.hoisted(() => {
  const value = process.env.CODE_AGENT_CLI_MODE;
  delete process.env.CODE_AGENT_CLI_MODE;
  return value;
});

import { DatabaseService } from '../../../src/host/services/core/databaseService';
import { TelemetryCollector } from '../../../src/host/telemetry/telemetryCollector';
import { TelemetryStorage } from '../../../src/host/telemetry/telemetryStorage';
import { SystemPromptCache } from '../../../src/host/telemetry/systemPromptCache';

const roots: string[] = [];
const databases: DatabaseService[] = [];

afterEach(async () => {
  for (const database of databases.splice(0)) database.close();
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

afterAll(() => {
  if (originalCliMode === undefined) delete process.env.CODE_AGENT_CLI_MODE;
  else process.env.CODE_AGENT_CLI_MODE = originalCliMode;
});

async function createState() {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'eval-case-data-'));
  roots.push(dataDir);
  const database = new DatabaseService(dataDir);
  databases.push(database);
  await database.initialize();
  const sqlite = database.getDb();
  if (!sqlite) throw new Error('Expected initialized database');
  return {
    dataDir,
    database,
    collector: new TelemetryCollector(
      new TelemetryStorage(sqlite),
      new SystemPromptCache(database),
    ),
  };
}

describe('per-case evaluation data isolation', () => {
  it('writes eval sessions into separate explicitly injected databases', async () => {
    const first = await createState();
    const second = await createState();

    first.database.createSessionWithId('session-a', {
      title: 'A', userId: null, modelConfig: { provider: 'openai', model: 'test' },
      workingDirectory: '/tmp/a', type: 'eval',
    });
    second.database.createSessionWithId('session-b', {
      title: 'B', userId: null, modelConfig: { provider: 'openai', model: 'test' },
      workingDirectory: '/tmp/b', type: 'eval',
    });

    first.collector.startSession('session-a', {
      title: 'A', modelProvider: 'openai', modelName: 'test', workingDirectory: '/tmp/a', sessionType: 'eval',
    });
    first.collector.endSession('session-a');
    second.collector.startSession('session-b', {
      title: 'B', modelProvider: 'openai', modelName: 'test', workingDirectory: '/tmp/b', sessionType: 'eval',
    });
    second.collector.endSession('session-b');
    first.collector.systemPromptCache.store('prompt-a', 'A');
    second.collector.systemPromptCache.store('prompt-b', 'B');

    expect(first.database.getDb()!.prepare('SELECT id, session_type FROM sessions').all())
      .toEqual([{ id: 'session-a', session_type: 'eval' }]);
    expect(second.database.getDb()!.prepare('SELECT id, session_type FROM sessions').all())
      .toEqual([{ id: 'session-b', session_type: 'eval' }]);
    expect(first.database.getDb()!.prepare('SELECT id, session_type FROM telemetry_sessions').all())
      .toEqual([{ id: 'session-a', session_type: 'eval' }]);
    expect(second.database.getDb()!.prepare('SELECT id, session_type FROM telemetry_sessions').all())
      .toEqual([{ id: 'session-b', session_type: 'eval' }]);
    expect(first.database.getDb()!.prepare('SELECT hash FROM system_prompt_cache').all())
      .toEqual([{ hash: 'prompt-a' }]);
    expect(second.database.getDb()!.prepare('SELECT hash FROM system_prompt_cache').all())
      .toEqual([{ hash: 'prompt-b' }]);
    expect(fs.existsSync(path.join(first.dataDir, 'code-agent.db'))).toBe(true);
    expect(fs.existsSync(path.join(second.dataDir, 'code-agent.db'))).toBe(true);
  });
});
