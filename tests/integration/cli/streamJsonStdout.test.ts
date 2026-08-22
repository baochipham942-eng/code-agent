import { afterEach, describe, expect, it } from 'vitest';
import { spawn } from 'node:child_process';
import { createServer, type Server } from 'node:http';
import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const REPO_ROOT = path.resolve(import.meta.dirname, '../../..');
const tempDirs: string[] = [];

function startFakeProvider(): Promise<{ baseUrl: string; server: Server }> {
  const server = createServer((request, response) => {
    expect(request.method).toBe('POST');
    expect(request.url).toBe('/v1/chat/completions');
    response.writeHead(200, {
      'Content-Type': 'text/event-stream',
      Connection: 'close',
    });
    response.write(`data: ${JSON.stringify({ choices: [{ delta: { content: 'ok' } }] })}\n\n`);
    response.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: 'stop' }] })}\n\n`);
    response.end('data: [DONE]\n\n');
  });

  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const address = server.address();
      if (!address || typeof address === 'string') {
        reject(new Error('fake provider did not bind a TCP port'));
        return;
      }
      resolve({ baseUrl: `http://127.0.0.1:${address.port}/v1`, server });
    });
  });
}

function runCli(dataDir: string): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
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
        HOME: dataDir,
        CODE_AGENT_DATA_DIR: path.join(dataDir, 'data'),
        CUSTOM_PROVIDER_API_KEY: 'fake-key',
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk; });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk; });
    child.once('error', reject);
    child.once('close', (code) => resolve({ code, stdout, stderr }));
  });
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe('CLI stream-json stdout', () => {
  it('keeps the spawned run process stdout as JSONL', async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), 'code-agent-cli-stream-json-'));
    tempDirs.push(tempDir);
    const { baseUrl, server } = await startFakeProvider();
    try {
      const dataDir = path.join(tempDir, 'data');
      await mkdir(dataDir, { recursive: true });
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

      const result = await runCli(tempDir);
      expect(result.code, result.stderr).toBe(0);

      const lines = result.stdout.split('\n').filter(Boolean);
      expect(lines).not.toHaveLength(0);
      const nonJsonLines = lines.filter((line) => {
        try {
          JSON.parse(line);
          return false;
        } catch {
          return true;
        }
      });
      expect(nonJsonLines).toEqual([]);
      expect(lines.map((line) => JSON.parse(line))).toContainEqual({
        type: 'result',
        timestamp: expect.any(Number),
        data: expect.objectContaining({ success: true, output: 'ok' }),
      });
    } finally {
      await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
    }
  }, 30_000);
});
