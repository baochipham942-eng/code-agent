import { randomUUID } from 'node:crypto';
import fs from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '../services/infra/logger';

const logger = createLogger('ModelPayloadDump');

interface ModelPayloadDumpInput {
  body: unknown;
  provider?: string;
  protocol: 'chat-completions' | 'responses';
  url: string;
}

function parseBody(body: unknown): unknown {
  if (typeof body !== 'string') return body;
  try {
    return JSON.parse(body) as unknown;
  } catch {
    return body;
  }
}

function requestPath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return '(invalid-url)';
  }
}

/**
 * 最终模型请求体调试探针。默认关闭；开启后失败也不能影响真实模型请求。
 * 文件只应落到临时、受控目录，原始内容禁止提交到仓库。
 */
export async function dumpModelPayload(input: ModelPayloadDumpInput): Promise<void> {
  const outputDir = process.env.CODE_AGENT_DUMP_MODEL_PAYLOAD;
  if (!outputDir) return;

  try {
    const payload = parseBody(input.body);
    const record = payload && typeof payload === 'object'
      ? payload as Record<string, unknown>
      : {};
    const dump = {
      schemaVersion: 1,
      provider: input.provider ?? null,
      protocol: input.protocol,
      requestPath: requestPath(input.url),
      // 统一镜像字段便于离线五桶统计；payload 保留 provider 最终线格式。
      messages: record.messages ?? record.input ?? record.contents ?? [],
      tools: record.tools ?? [],
      payload,
    };
    await fs.mkdir(outputDir, { recursive: true, mode: 0o700 });
    const file = path.join(outputDir, `${input.protocol}-${randomUUID()}.json`);
    await fs.writeFile(file, `${JSON.stringify(dump, null, 2)}\n`, { encoding: 'utf8', mode: 0o600 });
  } catch (error) {
    logger.warn('[ModelPayloadDump] dump 失败，已放行真实模型请求', {
      error: error instanceof Error ? error.message : String(error),
      protocol: input.protocol,
      provider: input.provider,
    });
  }
}
