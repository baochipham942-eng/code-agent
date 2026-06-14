import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionReplayEvidence } from '../../../src/renderer/utils/sessionReplayEvidence';
import { openSessionReplayEvidenceTarget } from '../../../src/renderer/utils/openSessionReplayEvidence';

function makeEvidence(overrides: Partial<SessionReplayEvidence>): SessionReplayEvidence {
  return {
    id: 'evidence-1',
    sessionId: 'session-1',
    type: 'replay',
    label: 'Workflow replay',
    title: 'Workflow replay',
    sourceLabel: 'Workflow',
    actionKind: 'sessionReplay',
    ...overrides,
  };
}

describe('openSessionReplayEvidenceTarget', () => {
  const deps = {
    openSessionReplay: vi.fn(async () => {}),
    openPath: vi.fn(async () => {}),
    openExternal: vi.fn(() => false),
    copyText: vi.fn(async () => true),
    notify: vi.fn(),
  };

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('opens session replay for workflow evidence without a concrete target', async () => {
    await openSessionReplayEvidenceTarget(makeEvidence({ actionKind: 'sessionReplay' }), deps);

    expect(deps.openSessionReplay).toHaveBeenCalledTimes(1);
    expect(deps.openPath).not.toHaveBeenCalled();
    expect(deps.copyText).not.toHaveBeenCalled();
  });

  it('opens local trace files with workspace openPath', async () => {
    await openSessionReplayEvidenceTarget(makeEvidence({
      type: 'trace',
      label: 'trace.json',
      actionKind: 'file',
      pathOrUrl: '/tmp/trace.json',
    }), deps);

    expect(deps.openPath).toHaveBeenCalledWith('/tmp/trace.json');
    expect(deps.notify).toHaveBeenCalledWith('success', '已打开 Trace 证据');
  });

  it('copies the path when opening a local evidence file fails', async () => {
    deps.openPath.mockRejectedValueOnce(new Error('missing file'));

    await openSessionReplayEvidenceTarget(makeEvidence({
      actionKind: 'file',
      pathOrUrl: '/tmp/missing-replay.json',
    }), deps);

    expect(deps.copyText).toHaveBeenCalledWith('/tmp/missing-replay.json');
    expect(deps.notify).toHaveBeenCalledWith(
      'error',
      '打开证据失败：missing file，已复制路径',
    );
  });

  it('opens http evidence links when the shell handles them', async () => {
    deps.openExternal.mockReturnValueOnce(true);

    await openSessionReplayEvidenceTarget(makeEvidence({
      actionKind: 'url',
      pathOrUrl: 'https://example.com/replay/1',
    }), deps);

    expect(deps.openExternal).toHaveBeenCalledWith('https://example.com/replay/1');
    expect(deps.copyText).not.toHaveBeenCalled();
    expect(deps.notify).toHaveBeenCalledWith('success', '已打开 Replay 链接');
  });

  it('copies opaque replay handles', async () => {
    await openSessionReplayEvidenceTarget(makeEvidence({
      actionKind: 'copy',
      pathOrUrl: 'replay://task-1',
    }), deps);

    expect(deps.copyText).toHaveBeenCalledWith('replay://task-1');
    expect(deps.notify).toHaveBeenCalledWith('success', '已复制证据位置');
  });
});
