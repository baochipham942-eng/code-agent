import { beforeEach, describe, expect, it, vi } from 'vitest';

const resolverState = vi.hoisted(() => ({
  definition: undefined as unknown,
  execute: vi.fn(),
}));

vi.mock('../../../src/host/tools/dispatch/toolResolver', () => ({
  getToolResolver: () => ({
    getDefinition: () => resolverState.definition,
    execute: resolverState.execute,
  }),
}));

vi.mock('../../../src/host/services/infra/logger', () => ({
  logger: { debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() },
  createLogger: () => ({ debug: vi.fn(), info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import type { ToolDefinition } from '../../../src/shared/contract';
import { TurnTraceRecorder } from '../../../src/host/agent/runtime/turnTrace';
import { resolveCanonicalRunPath } from '../../../src/host/runtime/runContext';
import { writeSchema } from '../../../src/host/tools/modules/file/write.schema';
import { ToolExecutor } from '../../../src/host/tools/toolExecutor';

const WORKSPACE = '/tmp/n-ledger-p3-workspace';

function definition(input: Partial<ToolDefinition> = {}): ToolDefinition {
  return {
    name: 'Write',
    description: 'test tool',
    inputSchema: { type: 'object', properties: {}, required: [] },
    outputSchema: { type: 'string' },
    requiresPermission: false,
    permissionLevel: 'write',
    ...input,
  };
}

describe('ToolExecutor compensation registration', () => {
  beforeEach(() => {
    resolverState.execute.mockReset();
    resolverState.execute.mockResolvedValue({ success: true, result: 'ok' });
    resolverState.definition = definition({ emission: writeSchema.emission });
  });

  it('registers successful external file emissions in strict LIFO order', async () => {
    expect(writeSchema.emission).toMatchObject({ kind: 'external_file_write' });
    const trace = new TurnTraceRecorder('compensation-lifo', '/tmp/n-ledger-p3-traces');
    vi.spyOn(trace, 'flush').mockReturnValue(true);
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: WORKSPACE,
    });

    await executor.execute('Write', { file_path: '/tmp/n-ledger-p3-first.txt' }, {
      sessionId: 'compensation-lifo',
      turnTrace: trace,
    });
    await executor.execute('Write', { file_path: '/tmp/n-ledger-p3-second.txt' }, {
      sessionId: 'compensation-lifo',
      turnTrace: trace,
    });

    const registrations = trace.getEvents().filter((event) => event.type === 'compensation_registered');
    expect(registrations.map((event) => event.data.order)).toEqual([1, 2]);
    expect([...registrations].reverse().map((event) => event.data.target)).toEqual([
      resolveCanonicalRunPath('/tmp/n-ledger-p3-second.txt'),
      resolveCanonicalRunPath('/tmp/n-ledger-p3-first.txt'),
    ]);
    expect(registrations[0]?.data).toMatchObject({
      toolName: 'Write',
      sufficiency: 'unreviewed',
      action: 'delete_created_file_or_restore_previous_content',
    });
  });

  it('does not register non-emission tools or writes that stay inside the workspace', async () => {
    const trace = new TurnTraceRecorder('compensation-negative', '/tmp/n-ledger-p3-traces');
    vi.spyOn(trace, 'flush').mockReturnValue(true);
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: WORKSPACE,
    });

    resolverState.definition = definition({ name: 'Read', permissionLevel: 'read' });
    await executor.execute('Read', { file_path: '/tmp/outside-read.txt' }, {
      sessionId: 'compensation-negative',
      turnTrace: trace,
    });

    resolverState.definition = definition({ emission: writeSchema.emission });
    await executor.execute('Write', { file_path: `${WORKSPACE}/inside.txt` }, {
      sessionId: 'compensation-negative',
      turnTrace: trace,
    });

    expect(trace.getEvents().filter((event) => event.type === 'compensation_registered')).toEqual([]);
  });

  it('keeps successful tool execution fail-safe when compensation trace persistence fails', async () => {
    const trace = new TurnTraceRecorder('compensation-fail-safe', '/tmp/n-ledger-p3-traces');
    vi.spyOn(trace, 'flush').mockImplementation(() => { throw new Error('trace unavailable'); });
    const executor = new ToolExecutor({
      requestPermission: vi.fn().mockResolvedValue(true),
      workingDirectory: WORKSPACE,
    });

    const result = await executor.execute('Write', { file_path: '/tmp/n-ledger-p3-fail-safe.txt' }, {
      sessionId: 'compensation-fail-safe',
      turnTrace: trace,
    });

    expect(result.success).toBe(true);
  });
});
