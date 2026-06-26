import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as fs from 'fs';
import * as path from 'path';
import os from 'os';
import { CompressionState } from '../../../src/host/context/compressionState';
import { applyArchiveHydration } from '../../../src/host/agent/runtime/contextAssembly/archiveHydration';
import type { ContextTranscriptEntry } from '../../../src/host/agent/runtime/contextAssembly/shared';

const testRoot = path.join(os.tmpdir(), `neo-context-archive-hydration-${process.pid}`);

vi.mock('../../../src/host/config/configPaths', async () => {
  const osMod = await import('os');
  const pathMod = await import('path');
  return {
    getUserConfigDir: () => pathMod.join(osMod.tmpdir(), `neo-context-archive-hydration-${process.pid}`),
  };
});

import { spillToolResultArchive } from '../../../src/host/utils/toolResultSpill';

function makeEntry(id: string, role: string, content: string): ContextTranscriptEntry {
  return {
    id,
    originMessageId: id,
    role,
    content,
    timestamp: 1000,
    turnIndex: 1,
  };
}

function stateWithArchive(archiveRef: NonNullable<ReturnType<typeof spillToolResultArchive>>['archiveRef']): CompressionState {
  const state = new CompressionState();
  state.applyCommit({
    layer: 'tool-result-budget',
    operation: 'truncate',
    targetMessageIds: [archiveRef.sourceMessageId || archiveRef.toolCallId || archiveRef.artifactId],
    timestamp: 1000,
    metadata: {
      originalTokens: 10000,
      truncatedTokens: 1000,
      archiveRef,
    },
  });
  return state;
}

describe('applyArchiveHydration', () => {
  beforeEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    fs.rmSync(testRoot, { recursive: true, force: true });
  });

  it('hydrates an explicitly requested archive id into the API view', () => {
    const archive = spillToolResultArchive({
      content: 'FULL RAW OUTPUT\nline two',
      toolName: 'Bash',
      sessionId: 'session-hydrate',
      toolCallId: 'call-1',
      sourceMessageId: 'tool-msg-1',
      reason: 'tool-result-budget',
    });
    expect(archive).not.toBeNull();
    const entries = [
      makeEntry('assistant-1', 'assistant', 'truncated output was archived'),
      makeEntry('user-1', 'user', `请复查完整输出 ${archive!.archiveRef.artifactId}`),
    ];

    const hydrated = applyArchiveHydration(entries, stateWithArchive(archive!.archiveRef));

    expect(hydrated).toHaveLength(3);
    expect(hydrated[2]).toMatchObject({
      role: 'system',
      originMessageId: 'tool-msg-1',
    });
    expect(hydrated[2].content).toContain('[Hydrated archived tool result]');
    expect(hydrated[2].content).toContain(archive!.archiveRef.artifactId);
    expect(hydrated[2].content).toContain('FULL RAW OUTPUT');
  });

  it('finds explicitly requested archives from sidecar when compression state no longer has the ref', () => {
    const archive = spillToolResultArchive({
      content: 'COMPACTED RAW OUTPUT',
      toolName: 'Bash',
      sessionId: 'session-after-compact',
      toolCallId: 'call-compact',
      sourceMessageId: 'tool-msg-compact',
      reason: 'tool-result-budget',
    });
    expect(archive).not.toBeNull();

    const hydrated = applyArchiveHydration(
      [makeEntry('user-1', 'user', `从 handoff 复查 ${archive!.archiveRef.artifactId} 的完整输出`)],
      new CompressionState(),
      'session-after-compact',
    );

    expect(hydrated).toHaveLength(2);
    expect(hydrated[1].content).toContain('COMPACTED RAW OUTPUT');
    expect(hydrated[1].content).toContain(archive!.archiveRef.artifactId);
  });

  it('hydrates only the latest archive for generic raw-evidence requests', () => {
    const older = spillToolResultArchive({
      content: 'OLDER OUTPUT',
      toolName: 'Bash',
      sessionId: 'session-hydrate',
      toolCallId: 'call-old',
    });
    const newer = spillToolResultArchive({
      content: 'NEWER OUTPUT',
      toolName: 'Bash',
      sessionId: 'session-hydrate',
      toolCallId: 'call-new',
    });
    expect(older).not.toBeNull();
    expect(newer).not.toBeNull();
    const state = stateWithArchive(older!.archiveRef);
    state.applyCommit({
      layer: 'tool-result-budget',
      operation: 'truncate',
      targetMessageIds: ['newer'],
      timestamp: 1001,
      metadata: {
        originalTokens: 10000,
        truncatedTokens: 1000,
        archiveRef: newer!.archiveRef,
      },
    });

    const hydrated = applyArchiveHydration(
      [makeEntry('user-1', 'user', '回看刚才命令完整输出')],
      state,
    );

    expect(hydrated).toHaveLength(2);
    expect(hydrated[1].content).toContain('NEWER OUTPUT');
    expect(hydrated[1].content).not.toContain('OLDER OUTPUT');
  });

  it('does not hydrate when the user did not request raw evidence', () => {
    const archive = spillToolResultArchive({
      content: 'SHOULD NOT APPEAR',
      toolName: 'Bash',
      sessionId: 'session-hydrate',
      toolCallId: 'call-1',
    });
    expect(archive).not.toBeNull();

    const hydrated = applyArchiveHydration(
      [makeEntry('user-1', 'user', '继续下一步')],
      stateWithArchive(archive!.archiveRef),
    );

    expect(hydrated).toHaveLength(1);
    expect(hydrated[0].content).toBe('继续下一步');
  });

  it('skips archives that fail validation', () => {
    const archive = spillToolResultArchive({
      content: 'ORIGINAL OUTPUT',
      toolName: 'Bash',
      sessionId: 'session-hydrate',
      toolCallId: 'call-1',
    });
    expect(archive).not.toBeNull();
    fs.writeFileSync(archive!.filePath, 'tampered', 'utf-8');

    const hydrated = applyArchiveHydration(
      [makeEntry('user-1', 'user', `看原文 ${archive!.archiveRef.artifactId}`)],
      stateWithArchive(archive!.archiveRef),
    );

    expect(hydrated).toHaveLength(1);
  });
});
