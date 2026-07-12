import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import type { McpTaskResultStore } from './mcpDurableTask';

const RESULT_REF_PREFIX = 'mcp-result:v1:';

export class McpTaskResultFileStore implements McpTaskResultStore {
  constructor(private readonly rootDir: string) {}

  async save(input: {
    runId: string;
    operationId: string;
    serverIdentity: string;
    taskId: string;
    result: unknown;
  }): Promise<string> {
    const identity = createHash('sha256').update(JSON.stringify({
      runId: input.runId,
      operationId: input.operationId,
      serverIdentity: input.serverIdentity,
      taskId: input.taskId,
    })).digest('hex');
    const resultRef = `${RESULT_REF_PREFIX}${identity}`;
    await fs.mkdir(this.rootDir, { recursive: true });
    const target = this.pathFor(resultRef);
    const temporary = `${target}.${process.pid}.tmp`;
    await fs.writeFile(temporary, JSON.stringify({
      schemaVersion: 1,
      identity: { runId: input.runId, operationId: input.operationId, serverIdentity: input.serverIdentity, taskId: input.taskId },
      result: input.result,
    }), { encoding: 'utf8', mode: 0o600 });
    await fs.rename(temporary, target);
    return resultRef;
  }

  async load(resultRef: string): Promise<unknown | null> {
    if (!resultRef.startsWith(RESULT_REF_PREFIX)) return null;
    try {
      const parsed = JSON.parse(await fs.readFile(this.pathFor(resultRef), 'utf8')) as {
        schemaVersion?: number;
        result?: unknown;
      };
      return parsed.schemaVersion === 1 ? parsed.result ?? null : null;
    } catch {
      return null;
    }
  }

  private pathFor(resultRef: string): string {
    const digest = resultRef.slice(RESULT_REF_PREFIX.length);
    if (!/^[a-f0-9]{64}$/.test(digest)) throw new Error('Invalid MCP task result reference');
    return path.join(this.rootDir, `${digest}.json`);
  }
}
