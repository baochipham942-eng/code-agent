import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  clearStreamSnapshot,
  createSnapshotHandler,
  getIncompleteToolCallIds,
  getStreamSnapshotPath,
  loadStreamSnapshot,
  markStreamSnapshotInterruptionReason,
  saveStreamSnapshot,
  type StreamSnapshotIdentity,
} from '../../../src/host/session/streamSnapshot';

const { loggerInfo, loggerWarn } = vi.hoisted(() => ({ loggerInfo: vi.fn(), loggerWarn: vi.fn() }));

vi.mock('../../../src/host/services/infra/logger', () => ({
  createLogger: () => ({
    info: loggerInfo,
    warn: loggerWarn,
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

const partialSnapshot = (content: string, timestamp = 100) => ({
  content,
  reasoning: '',
  toolCalls: [],
  estimatedTokens: 1,
  timestamp,
  isFinal: false,
});

describe('stream snapshot run isolation', () => {
  let tempDir: string;

  const identity = (overrides: Partial<StreamSnapshotIdentity> = {}): StreamSnapshotIdentity => ({
    workingDir: tempDir,
    sessionId: 'session-1',
    runId: 'run-1',
    turnId: 'turn-1',
    ...overrides,
  });

  beforeEach(() => {
    loggerWarn.mockClear();
    loggerInfo.mockClear();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'code-agent-stream-'));
  });

  afterEach(() => {
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('isolates two sessions writing in the same workspace', () => {
    saveStreamSnapshot(partialSnapshot('session one'), identity());
    saveStreamSnapshot(partialSnapshot('session two'), identity({
      sessionId: 'session-2',
      runId: 'run-2',
      turnId: 'turn-2',
    }));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' })?.content)
      .toBe('session one');
    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-2' })?.content)
      .toBe('session two');
  });

  it('does not let an old run clear a newer run snapshot', () => {
    saveStreamSnapshot(partialSnapshot('old run', 100), identity({ runId: 'run-old' }));
    saveStreamSnapshot(partialSnapshot('new run', 200), identity({ runId: 'run-new' }));

    clearStreamSnapshot(identity({ runId: 'run-old' }));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' }))
      .toMatchObject({ runId: 'run-new', content: 'new run' });
  });

  it('rejects a stale terminal callback after a newer run becomes owner', () => {
    const oldHandler = createSnapshotHandler(identity({ runId: 'run-old' }));
    oldHandler(partialSnapshot('old partial', 100));
    const newHandler = createSnapshotHandler(identity({ runId: 'run-new' }));
    newHandler(partialSnapshot('new partial', 200));

    oldHandler({ ...partialSnapshot('old final', 300), isFinal: true });

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' }))
      .toMatchObject({ runId: 'run-new', content: 'new partial' });
  });

  it('does not collide when two runs start in the same millisecond', () => {
    saveStreamSnapshot(partialSnapshot('run one', 100), identity({ runId: 'run-1' }));
    saveStreamSnapshot(partialSnapshot('run two', 100), identity({ runId: 'run-2' }));

    expect(getStreamSnapshotPath(identity({ runId: 'run-1' })))
      .not.toBe(getStreamSnapshotPath(identity({ runId: 'run-2' })));
    expect(JSON.parse(fs.readFileSync(getStreamSnapshotPath(identity({ runId: 'run-1' })), 'utf8')))
      .toMatchObject({ runId: 'run-1', content: 'run one', timestamp: 100 });
    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1', runId: 'run-2' })?.content)
      .toBe('run two');
  });

  it('keeps incomplete tool calls as evidence but never restores them for execution', () => {
    saveStreamSnapshot(
      {
        ...partialSnapshot(''),
        toolCalls: [
          { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
        ],
      },
      identity(),
    );

    const snapshot = loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' });

    expect(snapshot).toMatchObject({
      schemaVersion: 2,
      sessionId: 'session-1',
      runId: 'run-1',
      turnId: 'turn-1',
      workspace: fs.realpathSync(tempDir),
      streamStatus: 'incomplete',
      stableForExecution: false,
      incompleteToolCallIds: ['tool-1'],
      executionToolCalls: [],
    });
    expect(snapshot?.toolCalls).toHaveLength(1);
  });

  it('records the interruption reason on the owned incomplete snapshot', () => {
    saveStreamSnapshot(partialSnapshot('partial'), identity());

    markStreamSnapshotInterruptionReason(
      { workingDir: tempDir, sessionId: 'session-1' },
      'user',
    );

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' }))
      .toMatchObject({ interruptionReason: 'user' });
  });

  it('keeps the interruption reason when the abort flush writes the last partial', () => {
    const handler = createSnapshotHandler(identity());
    handler(partialSnapshot('before stop'));
    markStreamSnapshotInterruptionReason(
      { workingDir: tempDir, sessionId: 'session-1' },
      'user',
    );

    handler(partialSnapshot('abort flush'));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' }))
      .toMatchObject({ content: 'abort flush', interruptionReason: 'user' });
  });

  it('explicitly discards an unscoped legacy snapshot instead of attaching it to a session', () => {
    const legacyPath = path.join(tempDir, '.code-agent', 'stream-snapshot.json');
    fs.mkdirSync(path.dirname(legacyPath), { recursive: true });
    fs.writeFileSync(legacyPath, JSON.stringify({
      ...partialSnapshot('legacy'),
      sessionId: 'session-1',
      turnId: 'turn-legacy',
    }));

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' })).toBeNull();
    expect(fs.existsSync(legacyPath)).toBe(false);
    expect(loggerWarn).toHaveBeenCalledWith(
      'Discarded legacy unscoped stream snapshot; run identity was unavailable',
    );
  });

  it('keeps the last valid snapshot readable when an orphan temp file is truncated', () => {
    const scopedIdentity = identity();
    saveStreamSnapshot(partialSnapshot('valid'), scopedIdentity);
    fs.writeFileSync(`${getStreamSnapshotPath(scopedIdentity)}.crashed.tmp`, '{');

    expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-1' })?.content)
      .toBe('valid');
  });

  it('redacts credentials from persisted tool arguments', () => {
    saveStreamSnapshot({
      ...partialSnapshot('Authorization: Bearer content-secret-token'),
      reasoning: 'api_key=reasoning-secret-key',
      toolCalls: [{
        id: 'tool-secret',
        name: 'http_request',
        arguments: JSON.stringify({
          apiKey: 'sk-test-secret-12345',
          headers: { Authorization: 'Bearer top-secret-token' },
        }),
      }],
    }, identity());

    const persisted = fs.readFileSync(getStreamSnapshotPath(identity()), 'utf8');
    expect(persisted).not.toContain('sk-test-secret-12345');
    expect(persisted).not.toContain('top-secret-token');
    expect(persisted).not.toContain('content-secret-token');
    expect(persisted).not.toContain('reasoning-secret-key');
    expect(persisted).toContain('***REDACTED***');
  });

  it('does not report incomplete ids for final snapshots', () => {
    expect(getIncompleteToolCallIds({
      isFinal: true,
      toolCalls: [
        { id: 'tool-1', name: 'write_file', arguments: '{"file_path":"/tmp/a"' },
      ],
    })).toEqual([]);
  });

  // —— N-STREAMSNAPSHOT-LOG-SPAM：INFO 只按 (session, run, turn) 首次发现打一条 ——
  it('运行中重复 load 同一未完成快照只打一条 INFO（200~580 条/分钟刷屏的日志侧收口）', () => {
    saveStreamSnapshot(partialSnapshot('partial'), identity({
      sessionId: 'session-log',
      runId: 'run-log',
      turnId: 'turn-log',
    }));

    // 模拟一段运行中的刷新窗口：渲染层快照重灌风暴在基线上可达每秒数次 load
    for (let i = 0; i < 200; i++) {
      expect(loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-log' }))
        .toMatchObject({ content: 'partial', turnId: 'turn-log' });
    }

    expect(loggerInfo).toHaveBeenCalledTimes(1);
    expect(loggerInfo).toHaveBeenCalledWith('Found incomplete stream snapshot', expect.objectContaining({
      sessionId: 'session-log',
      runId: 'run-log',
      turnId: 'turn-log',
    }));
  });

  it('新 turn / 新 run 的未完成快照仍各自打一条（key 含 run 与 turn）', () => {
    saveStreamSnapshot(partialSnapshot('turn a'), identity({
      sessionId: 'session-log-2',
      runId: 'run-log-2',
      turnId: 'turn-a',
    }));
    loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-log-2' });

    saveStreamSnapshot(partialSnapshot('turn b'), identity({
      sessionId: 'session-log-2',
      runId: 'run-log-2',
      turnId: 'turn-b',
    }));
    loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-log-2' });

    saveStreamSnapshot(partialSnapshot('other run'), identity({
      sessionId: 'session-log-3',
      runId: 'run-log-3',
      turnId: 'turn-a',
    }));
    loadStreamSnapshot({ workingDir: tempDir, sessionId: 'session-log-3' });

    expect(loggerInfo).toHaveBeenCalledTimes(3);
  });
});
