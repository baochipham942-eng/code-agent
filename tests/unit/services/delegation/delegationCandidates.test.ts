import { createHash, createHmac } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  projectSessionCandidates,
  resolveCandidateRef,
  type SessionCandidateRow,
} from '../../../../src/host/services/delegation/delegationCandidates';

const SECRET = 'candidate-secret';
const NOW = 1_700_000_000_000;

function row(overrides: Partial<SessionCandidateRow> = {}): SessionCandidateRow {
  return {
    id: 'session-a',
    title: '会话 A',
    workingDirectory: '/tmp/workspace/project-a',
    updatedAt: NOW - 1000,
    ...overrides,
  };
}

describe('projectSessionCandidates', () => {
  it('只收 chat、未归档未删除、非发起会话、native 引擎', () => {
    const projection = projectSessionCandidates([
      row({ id: 'keep-chat' }),
      row({ id: 'drop-schedule', sessionType: 'schedule' }),
      row({ id: 'drop-heartbeat', sessionType: 'heartbeat' }),
      row({ id: 'drop-subagent', sessionType: 'subagent' }),
      row({ id: 'drop-eval', sessionType: 'eval' }),
      row({ id: 'drop-archived', isArchived: true }),
      row({ id: 'drop-deleted', isDeleted: true }),
      row({ id: 'origin-1' }),
      row({ id: 'drop-engine', engineKind: 'codex_cli' }),
    ], { originSessionId: 'origin-1', now: NOW, secret: SECRET });

    expect(projection.sessionIds).toEqual(['keep-chat']);
  });

  it('用户手动分叉的会话（chat 带父会话）也是候选', () => {
    const projection = projectSessionCandidates([
      row({ id: 'forked', parentSessionId: 'origin-1' }),
    ], { originSessionId: 'origin-1', now: NOW, secret: SECRET });
    expect(projection.sessionIds).toEqual(['forked']);
  });

  it('按 updatedAt 降序、id 升序排序，40 行截断 32', () => {
    const rows = Array.from({ length: 40 }, (_, index) =>
      row({ id: `s-${String(index).padStart(2, '0')}`, updatedAt: NOW - index * 1000 }));
    const projection = projectSessionCandidates(rows, {
      originSessionId: 'origin-1',
      now: NOW,
      secret: SECRET,
    });
    expect(projection.candidates).toHaveLength(32);
    expect(projection.sessionIds[0]).toBe('s-00');
    expect(projection.sessionIds).not.toContain('s-39');

    const sameTime = [
      row({ id: 'b', updatedAt: NOW }),
      row({ id: 'a', updatedAt: NOW }),
    ];
    expect(projectSessionCandidates(sameTime, { originSessionId: 'origin-1', now: NOW, secret: SECRET }).sessionIds)
      .toEqual(['a', 'b']);
  });

  it('输出无 stable sessionId；host 内部 sessionIds 与条目平行', () => {
    const projection = projectSessionCandidates(
      [row({ id: 'session-a' }), row({ id: 'session-b' })],
      { originSessionId: 'origin-1', now: NOW, secret: SECRET },
    );
    expect(projection.candidates).toHaveLength(2);
    for (const candidate of projection.candidates) {
      expect(Object.keys(candidate).sort()).toEqual(
        ['candidateRef', 'freshness', 'shortName', 'status', 'workspaceName'],
      );
    }
    expect(projection.sessionIds).toEqual(['session-a', 'session-b']);
  });

  it('candidateRef 同一快照内稳定（重复投影逐字节相同）', () => {
    const rows = [row({ id: 'session-a' }), row({ id: 'session-b' })];
    const first = projectSessionCandidates(rows, { originSessionId: 'origin-1', now: NOW, secret: SECRET });
    const second = projectSessionCandidates(rows, { originSessionId: 'origin-1', now: NOW, secret: SECRET });
    expect(first).toEqual(second);
    expect(new Set(first.candidates.map((c) => c.candidateRef)).size).toBe(2);
  });

  it('快照变化后旧 ref 解析 candidate_set_stale；不碰运气的 ref 解析 ambiguous', () => {
    const before = projectSessionCandidates(
      [row({ id: 'session-a' })],
      { originSessionId: 'origin-1', now: NOW, secret: SECRET },
    );
    const after = projectSessionCandidates(
      [row({ id: 'session-a' }), row({ id: 'session-b' })],
      { originSessionId: 'origin-1', now: NOW, secret: SECRET },
    );
    const oldRef = before.candidates[0].candidateRef;

    expect(resolveCandidateRef(
      { candidateSetId: before.candidateSetId, candidateRef: oldRef },
      after,
      SECRET,
    )).toEqual({ ok: false, code: 'candidate_set_stale' });
    expect(resolveCandidateRef({ candidateRef: 'not-a-ref' }, after, SECRET))
      .toEqual({ ok: false, code: 'ambiguous' });
    expect(resolveCandidateRef({ candidateSetId: after.candidateSetId }, after, SECRET))
      .toEqual({ ok: false, code: 'ambiguous' });
  });

  it('当前快照内的 ref 反查出 sessionId', () => {
    const projection = projectSessionCandidates(
      [row({ id: 'session-a' })],
      { originSessionId: 'origin-1', now: NOW, secret: SECRET },
    );
    expect(resolveCandidateRef(
      { candidateSetId: projection.candidateSetId, candidateRef: projection.candidates[0].candidateRef },
      projection,
      SECRET,
    )).toEqual({ ok: true, sessionId: 'session-a' });
  });

  it('短名 40 字符截断、工作区短名取 basename、新鲜度分桶、running 状态来自输入旗标', () => {
    const projection = projectSessionCandidates([
      row({
        id: 'long-title',
        title: 'x'.repeat(60),
        workingDirectory: '/tmp/workspace/deep/project',
        updatedAt: NOW - 30 * 60 * 1000,
      }),
      row({ id: 'day-old', title: '', updatedAt: NOW - 3 * 60 * 60 * 1000 }),
      row({ id: 'week-old', updatedAt: NOW - 2 * 24 * 60 * 60 * 1000 }),
      row({ id: 'ancient', workingDirectory: undefined, updatedAt: NOW - 30 * 24 * 60 * 60 * 1000 }),
    ], {
      originSessionId: 'origin-1',
      now: NOW,
      secret: SECRET,
      isRunning: (sessionId) => sessionId === 'long-title',
    });

    const [longTitle, dayOld, weekOld, ancient] = projection.candidates;
    expect(longTitle.shortName).toHaveLength(40);
    expect(longTitle.workspaceName).toBe('project');
    expect(longTitle.status).toBe('running');
    expect(longTitle.freshness).toBe('1h');
    expect(dayOld.freshness).toBe('1d');
    expect(dayOld.shortName).toBe('');
    expect(weekOld.freshness).toBe('7d');
    expect(ancient.freshness).toBe('older');
    expect(ancient.workspaceName).toBe('');
    expect(dayOld.status).toBe('idle');
  });
});

describe('候选投影金向量（D3/D5 字节级公式，字面量钉死）', () => {
  const rows = [
    row({ id: 'session-a', updatedAt: NOW - 1000 }),
    row({ id: 'session-b', updatedAt: NOW - 2000 }),
  ];
  const projection = projectSessionCandidates(rows, {
    originSessionId: 'origin-1',
    now: NOW,
    secret: SECRET,
  });

  it('candidateSetId = 有序 session id 以 \\0 连接的 sha256 前 16 hex（字面量）', () => {
    expect(projection.sessionIds).toEqual(['session-a', 'session-b']);
    expect(projection.candidateSetId).toBe('995bd339aa5855a1');
    // 顺序是公式的一部分：排序结果不同（b 更新）→ 集合指纹不同。
    const bNewer = projectSessionCandidates(
      [row({ id: 'session-a', updatedAt: NOW - 5000 }), row({ id: 'session-b', updatedAt: NOW - 10 })],
      { originSessionId: 'origin-1', now: NOW, secret: SECRET },
    );
    expect(bNewer.sessionIds).toEqual(['session-b', 'session-a']);
    expect(bNewer.candidateSetId).not.toBe(projection.candidateSetId);
    // 输入行序打乱不影响排序结果 → 集合指纹不变。
    const shuffled = projectSessionCandidates([...rows].reverse(), {
      originSessionId: 'origin-1',
      now: NOW,
      secret: SECRET,
    });
    expect(shuffled.candidateSetId).toBe(projection.candidateSetId);
  });

  it('candidateRef = base64url(HMAC-SHA256(secret, setId\\0sessionId)) 前 16 字符（字面量 + 独立重算）', () => {
    expect(projection.candidates[0].candidateRef).toBe('9uhwlyECHJCSwa5W');
    const recomputed = createHmac('sha256', SECRET)
      .update(`${projection.candidateSetId}\0session-a`, 'utf8')
      .digest('base64url')
      .slice(0, 16);
    expect(projection.candidates[0].candidateRef).toBe(recomputed);
  });

  it('换 secret → 同一会话的 ref 全变；集合指纹不随 secret 变', () => {
    const other = projectSessionCandidates(rows, {
      originSessionId: 'origin-1',
      now: NOW,
      secret: 'other-secret',
    });
    expect(other.candidates[0].candidateRef).not.toBe(projection.candidates[0].candidateRef);
    expect(other.candidateSetId).toBe(projection.candidateSetId);
    expect(createHash('sha256').update('session-a\0session-b', 'utf8').digest('hex').slice(0, 16))
      .toBe(projection.candidateSetId);
  });
});
