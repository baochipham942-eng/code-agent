import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Message, Session } from '../../../src/shared/contract';
import { CLIDatabaseService } from '../../../src/cli/database';
import { addAndPersistMessage } from '../../../src/host/agent/runtime/contextAssembly/systemContextStack';
import { TurnState } from '../../../src/host/agent/runtime/turnState';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');

function parseCorrelationTurnId(metadata: unknown): string | undefined {
  if (!metadata || typeof metadata !== 'object') return undefined;
  const correlation = (metadata as { correlation?: { turnId?: unknown } }).correlation;
  const turnId = correlation?.turnId;
  return typeof turnId === 'string' && turnId.trim() ? turnId.trim() : undefined;
}

describe('assistant correlation.turnId persist coverage', () => {
  let tmpDir: string;
  let prevDataDir: string | undefined;
  let db: CLIDatabaseService;

  afterEach(() => {
    try { db?.close?.(); } catch { /* noop */ }
    if (prevDataDir === undefined) delete process.env.CODE_AGENT_DATA_DIR;
    else process.env.CODE_AGENT_DATA_DIR = prevDataDir;
    if (tmpDir) fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('100 assistant messages persisted through addAndPersistMessage all carry correlation.turnId', async () => {
    prevDataDir = process.env.CODE_AGENT_DATA_DIR;
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'neo-corr-coverage-'));
    process.env.CODE_AGENT_DATA_DIR = tmpDir;
    db = new CLIDatabaseService();
    await db.initialize();
    const session: Session = {
      id: 'sess-coverage',
      title: 'correlation coverage',
      modelConfig: { provider: 'custom', model: 'fake-model' },
      createdAt: Date.now(),
      updatedAt: Date.now(),
    } as Session;
    db.createSession(session);

    const sample = 100;
    for (let index = 0; index < sample; index += 1) {
      const turn = new TurnState();
      const turnId = `turn-coverage-${index}`;
      turn.beginTurn(turnId, `span-${index}`);
      const message: Message = {
        id: `assistant-${index}`,
        role: 'assistant',
        content: `coverage reply ${index}`,
        timestamp: Date.now() + index,
      };
      const ctx = {
        runtime: {
          sessionId: session.id,
          messages: [] as Message[],
          turn,
          persistMessage: async (persisted: Message) => {
            db.addMessage(session.id, persisted);
          },
        },
        recordContextEventsForMessage: () => undefined,
      };
      await addAndPersistMessage(ctx as never, message);
    }

    const assistants = db.getMessages(session.id).filter((message) => message.role === 'assistant');
    expect(assistants).toHaveLength(sample);
    const missing = assistants.filter((message) => !parseCorrelationTurnId(message.metadata));
    expect(missing).toEqual([]);
    expect(assistants.every((message, index) => (
      parseCorrelationTurnId(message.metadata) === `turn-coverage-${index}`
    ))).toBe(true);
  });

  it('CLI run in a fresh data dir persists assistant messages with correlation.turnId', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'neo-corr-cli-'));
    tmpDir = tempDir;
    const dataDir = path.join(tempDir, 'data');
    await mkdir(dataDir, { recursive: true });

    const server = createServer((request, response) => {
      expect(request.method).toBe('POST');
      response.writeHead(200, {
        'Content-Type': 'text/event-stream',
        Connection: 'close',
      });
      response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'cli-coverage-ok' } }] })}\n\n`);
      response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
      response.end('data: [DONE]\n\n');
    });
    const baseUrl = await new Promise<string>((resolve, reject) => {
      server.once('error', reject);
      server.listen(0, '127.0.0.1', () => {
        const address = server.address();
        if (!address || typeof address === 'string') {
          reject(new Error('fake provider did not bind'));
          return;
        }
        resolve(`http://127.0.0.1:${address.port}/v1`);
      });
    });

    await writeFile(path.join(dataDir, 'config.json'), JSON.stringify({
      models: {
        defaultProvider: 'custom',
        default: 'custom',
        providers: {
          custom: { enabled: true, model: 'fake-model', baseUrl },
        },
        routing: {
          chat: { provider: 'custom', model: 'fake-model' },
          code: { provider: 'custom', model: 'fake-model' },
          fast: { provider: 'custom', model: 'fake-model' },
        },
      },
    }), 'utf-8');

    try {
      const result = await new Promise<{ code: number | null; stderr: string }>((resolve, reject) => {
        const child = spawn(process.execPath, [
          '--import', 'tsx', 'src/cli/index.ts',
          '--provider', 'custom',
          '--model', 'fake-model',
          '--output-format', 'stream-json',
          'run', 'say hi',
        ], {
          cwd: REPO_ROOT,
          env: {
            ...process.env,
            HOME: tempDir,
            CODE_AGENT_DATA_DIR: dataDir,
            CUSTOM_PROVIDER_API_KEY: 'fake-key',
          },
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        let stderr = '';
        child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
        child.once('error', reject);
        child.once('close', (code) => resolve({ code, stderr }));
      });
      expect(result.code, result.stderr).toBe(0);

      prevDataDir = process.env.CODE_AGENT_DATA_DIR;
      process.env.CODE_AGENT_DATA_DIR = dataDir;
      db = new CLIDatabaseService();
      await db.initialize();
      const sessions = db.listSessions();
      const assistants = sessions.flatMap((session) => (
        db.getMessages(session.id).filter((message) => message.role === 'assistant')
      ));
      expect(assistants.length).toBeGreaterThan(0);
      const missing = assistants.filter((message) => !parseCorrelationTurnId(message.metadata));
      expect(missing).toEqual([]);
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
      tmpDir = '';
    }
  }, 30_000);
});
