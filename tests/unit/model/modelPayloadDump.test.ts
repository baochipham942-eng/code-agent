import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { dumpModelPayload } from '../../../src/host/model/modelPayloadDump';

const originalOutputDir = process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD;
const tempDirs: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  if (originalOutputDir === undefined) delete process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD;
  else process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD = originalOutputDir;
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

describe('modelPayloadDump', () => {
  it('默认关闭时不落盘', async () => {
    delete process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD;
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-payload-dump-off-'));
    tempDirs.push(dir);
    await dumpModelPayload({ body: '{}', protocol: 'responses', url: 'https://example.test/responses' });
    expect(await fs.readdir(dir)).toEqual([]);
  });

  it('保留最终 payload 并提供统一 messages/tools 镜像', async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'model-payload-dump-on-'));
    tempDirs.push(dir);
    process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD = dir;
    const body = {
      model: 'test-model',
      input: [{ role: 'user', content: 'hello' }],
      tools: [{ type: 'function', name: 'Read', parameters: { type: 'object' } }],
    };
    await dumpModelPayload({ body, provider: 'test', protocol: 'responses', url: 'https://example.test/v1/responses?secret=no' });
    const [file] = await fs.readdir(dir);
    const dump = JSON.parse(await fs.readFile(path.join(dir, file), 'utf8'));
    expect(dump.requestPath).toBe('/v1/responses');
    expect(dump.messages).toEqual(body.input);
    expect(dump.tools).toEqual(body.tools);
    expect(dump.payload).toEqual(body);
  });

  it('落盘失败时 fail-safe 放行', async () => {
    process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD = '/dev/null/blocked';
    await expect(dumpModelPayload({ body: '{}', protocol: 'chat-completions', url: 'invalid' })).resolves.toBeUndefined();
  });
});
