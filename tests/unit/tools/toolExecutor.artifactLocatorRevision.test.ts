import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { getProtocolRegistry } from '../../../src/host/tools/protocolRegistry';
import {
  computeArtifactRevision,
  getArtifactLocatorPreflightBlock,
} from '../../../src/host/tools/artifacts/artifactLocatorHost';
import {
  ToolExecutor,
  type ToolExecutionDelegate,
} from '../../../src/host/tools/toolExecutor';
import type { Message, ToolCall } from '../../../src/shared/contract';
import type { ArtifactLocatorV1 } from '../../../src/shared/contract/artifactLocator';

describe('ToolExecutor guarded artifact revision advancement', () => {
  let workDir: string;

  beforeAll(() => {
    getProtocolRegistry();
  });

  beforeEach(async () => {
    workDir = await mkdtemp(join(tmpdir(), 'tool-executor-locator-revision-'));
  });

  afterEach(async () => {
    await rm(workDir, { recursive: true, force: true });
  });

  async function fixture(name: string) {
    const filePath = join(workDir, name);
    await writeFile(filePath, 'locator revision');
    const locator: ArtifactLocatorV1 = {
      version: 1,
      artifact: {
        kind: 'spreadsheet',
        filePath,
        revision: await computeArtifactRevision(filePath),
      },
      target: { kind: 'sheet-range', sheetName: 'Sheet1', a1: 'B4' },
      display: { label: name },
    };
    const messages = [
      { id: 'u1', role: 'user', content: '定点编辑', timestamp: 1, metadata: { artifactLocator: locator } },
    ] as Message[];
    return { filePath, messages };
  }

  function call(id: string, filePath: string, action: 'set_cell' | 'set_style'): ToolCall {
    return {
      id,
      name: 'DocEdit',
      arguments: {
        file_path: filePath,
        operations: [{ action, sheet: 'Sheet1', cell: 'B4', value: action === 'set_cell' ? 42 : undefined }],
      },
    };
  }

  async function preflight(
    messages: Message[],
    toolCall: ToolCall,
    sessionId = 'session-guarded-chain',
  ) {
    return getArtifactLocatorPreflightBlock(
      { messages, workingDirectory: workDir, sessionId },
      toolCall,
    );
  }

  function executor(dispatch: ToolExecutionDelegate) {
    const instance = new ToolExecutor({
      workingDirectory: workDir,
      requestPermission: vi.fn(async () => true),
      dispatchTool: dispatch,
    });
    instance.setAuditEnabled(false);
    return instance;
  }

  it('set_cell 成功后，同回合 set_style 接受紧邻的自身写入 revision', async () => {
    const { filePath, messages } = await fixture('two-step.xlsx');
    const first = call('call-success-1', filePath, 'set_cell');
    expect(await preflight(messages, first)).toBeNull();

    const dispatch: ToolExecutionDelegate = vi.fn(async () => {
      await writeFile(filePath, 'after set_cell');
      return { success: true, output: 'ok' };
    });
    const result = await executor(dispatch).execute(first.name, first.arguments, {
      sessionId: 'session-guarded-chain',
      currentToolCallId: first.id,
    });
    expect(result.success).toBe(true);

    const second = call('call-success-2', filePath, 'set_style');
    expect(await preflight(messages, second)).toBeNull();
  });

  it('首写失败即使留下文件变化，也不推进 revision chain', async () => {
    const { filePath, messages } = await fixture('failed-first.xlsx');
    const first = call('call-failed-1', filePath, 'set_cell');
    expect(await preflight(messages, first)).toBeNull();

    const dispatch: ToolExecutionDelegate = vi.fn(async () => {
      await writeFile(filePath, 'partial mutation from failed write');
      return { success: false, error: 'write failed' };
    });
    const result = await executor(dispatch).execute(first.name, first.arguments, {
      sessionId: 'session-guarded-chain',
      currentToolCallId: first.id,
    });
    expect(result.success).toBe(false);

    const block = await preflight(messages, call('call-failed-2', filePath, 'set_style'));
    expect(block?.metadata.reason).toBe('revision_drift');
  });

  it('自身成功写入后又被外部改写，仍然 revision_drift fail-closed', async () => {
    const { filePath, messages } = await fixture('external-drift.xlsx');
    const first = call('call-external-1', filePath, 'set_cell');
    expect(await preflight(messages, first)).toBeNull();

    const dispatch: ToolExecutionDelegate = vi.fn(async () => {
      await writeFile(filePath, 'after guarded write');
      return { success: true, output: 'ok' };
    });
    const result = await executor(dispatch).execute(first.name, first.arguments, {
      sessionId: 'session-guarded-chain',
      currentToolCallId: first.id,
    });
    expect(result.success).toBe(true);

    await writeFile(filePath, 'external rewrite');
    const block = await preflight(messages, call('call-external-2', filePath, 'set_style'));
    expect(block?.metadata.reason).toBe('revision_drift');
    expect(block?.error).toContain('刷新');
  });

  it('另一 actor 不能复用已记录的成功 revision', async () => {
    const { filePath, messages } = await fixture('other-actor.xlsx');
    const first = call('call-actor-1', filePath, 'set_cell');
    expect(await preflight(messages, first)).toBeNull();

    const dispatch: ToolExecutionDelegate = vi.fn(async () => {
      await writeFile(filePath, 'after actor A write');
      return { success: true, output: 'ok' };
    });
    const result = await executor(dispatch).execute(first.name, first.arguments, {
      sessionId: 'session-guarded-chain',
      currentToolCallId: first.id,
    });
    expect(result.success).toBe(true);

    const block = await preflight(
      messages,
      call('call-actor-2', filePath, 'set_style'),
      'session-other-actor',
    );
    expect(block?.metadata.reason).toBe('revision_drift');
  });
});
