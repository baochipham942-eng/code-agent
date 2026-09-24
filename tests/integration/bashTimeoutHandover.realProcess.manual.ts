import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Logger } from '../../src/host/protocol/tools';
import { bashModule } from '../../src/host/tools/modules/shell/bash';
import { getTaskOutput, killBackgroundTask } from '../../src/host/tools/shell/backgroundTasks';

const posixOnly = process.platform === 'win32' ? describe.skip : describe;

function logger(): Logger {
  return { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} };
}

async function waitForOutput(taskId: string, marker: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const output = await getTaskOutput(taskId);
    if (output?.output.includes(marker)) return output.output;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Timed out waiting for ${marker}`);
}

posixOnly('Bash timeout handover real process', () => {
  it('adopts the 150-second one-line-per-second process and retrieves second 100', async () => {
    const cwd = mkdtempSync(join(tmpdir(), 'neo-timeout-handover-'));
    const abort = new AbortController();
    const handler = await bashModule.createHandler();
    const result = await handler.execute(
      {
        command: 'for i in $(seq 1 150); do printf "second-%s\\n" "$i"; sleep 1; done',
        timeout: 5_000,
      },
      {
        sessionId: `real-handover-${Date.now()}`,
        workingDir: cwd,
        abortSignal: abort.signal,
        logger: logger(),
        emit: () => {},
      },
      async () => ({ allow: true }),
    );

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const taskId = String(result.meta?.taskId ?? '');
    expect(taskId).not.toBe('');
    expect(result.output).toContain('<task-type>bash-timeout-handover</task-type>');
    expect(result.output).toContain('second-1');
    abort.abort();

    try {
      const output = await waitForOutput(taskId, 'second-100', 110_000);
      expect(output).toContain('second-100');
    } finally {
      await killBackgroundTask(taskId);
    }
  }, 125_000);
});
