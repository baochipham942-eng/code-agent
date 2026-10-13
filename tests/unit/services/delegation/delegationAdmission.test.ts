import { describe, expect, it } from 'vitest';

import {
  admitDelegation,
  parseDelegateSessionCall,
  recheckForDelivery,
  workspacesOverlap,
  type DelegationAdmissionSnapshot,
  type DelegateSessionCall,
  type DelegationDeliverySnapshot,
  type DelegationFolderTrustFact,
} from '../../../../src/host/services/delegation/delegationAdmission';
import { deriveActionFingerprint } from '../../../../src/host/services/delegation/delegationKeys';

/** tsc-tests 棘轮：判别联合须先收窄再取 .call——非法输入另有专测，这里一律断言 ok。 */
function parseOkCall(args: unknown): DelegateSessionCall {
  const parsed = parseDelegateSessionCall(args);
  if (!parsed.ok) throw new Error(`unexpected invalid delegate_session args: ${parsed.detail}`);
  return parsed.call;
}

function healthySnapshot(
  overrides: Partial<DelegationAdmissionSnapshot> = {},
): DelegationAdmissionSnapshot {
  return {
    originSessionId: 'origin-1',
    originTurnId: 'turn-1',
    hostWorkspaceRoot: '/authorized/root',
    candidates: {
      candidateSetId: 'set-current',
      candidateRefs: ['ref-target-a'],
      candidateSessionIds: ['target-a'],
    },
    target: {
      sessionId: 'target-a',
      sessionExists: true,
      isArchived: false,
      isDeleted: false,
      sessionType: 'chat',
      engineKind: 'native',
      workspaceRoot: '/ws/target-a',
      workspaceAuthorized: true,
      permissionMode: 'default',
      folderTrust: { state: 'trusted', blockedItems: 0 },
    },
    runningTurns: [],
    targetActiveRunId: null,
    delegatedRunIds: [],
    userQueuedOrSendingRows: 0,
    existingDelegation: null,
    chainDelegation: null,
    ...overrides,
  };
}

function delegateExistingCall(overrides: Record<string, unknown> = {}) {
  return {
    action: 'delegate_existing',
    content: 'do the thing',
    candidateRef: 'ref-target-a',
    ...overrides,
  };
}

describe('parseDelegateSessionCall（D4 调用形状）', () => {
  it('未知 action → invalid_call（真阳），合法 action 通过（真阴）', () => {
    expect(parseDelegateSessionCall({ action: 'route_message', content: 'x' }))
      .toMatchObject({ ok: false, code: 'invalid_call' });
    const ok = parseDelegateSessionCall(delegateExistingCall());
    expect(ok).toMatchObject({ ok: true, call: { action: 'delegate_existing' } });
  });

  it('多余键 → invalid_call（真阳），白名单键通过（真阴）', () => {
    expect(parseDelegateSessionCall(delegateExistingCall({ extra: 1 })))
      .toMatchObject({ ok: false, code: 'invalid_call' });
    expect(parseDelegateSessionCall({
      action: 'delegate_existing',
      content: 'x',
      candidateRef: 'ref-1',
      candidateSetId: 'set-1',
    })).toMatchObject({ ok: true });
  });

  it('模型自带 sessionId → invalid_call（真阳）', () => {
    expect(parseDelegateSessionCall(delegateExistingCall({ sessionId: 'target-a' })))
      .toMatchObject({ ok: false, code: 'invalid_call' });
    expect(parseDelegateSessionCall({ action: 'stop', delegationId: 'd-1', targetSessionId: 's' }))
      .toMatchObject({ ok: false, code: 'invalid_call' });
  });

  it('create_new 带工作区/路径 → invalid_call（真阳），纯任务文本通过（真阴）', () => {
    for (const key of ['workspace', 'workingDirectory', 'path']) {
      expect(parseDelegateSessionCall({ action: 'create_new', content: 'x', [key]: '/tmp' }))
        .toMatchObject({ ok: false, code: 'invalid_call' });
    }
    expect(parseDelegateSessionCall({ action: 'create_new', content: '新活' }))
      .toMatchObject({ ok: true, call: { action: 'create_new', content: '新活' } });
  });

  it('链上操作缺 delegationId → invalid_call（真阳），带 delegationId 通过（真阴）', () => {
    expect(parseDelegateSessionCall({ action: 'stop' }))
      .toMatchObject({ ok: false, code: 'invalid_call' });
    expect(parseDelegateSessionCall({ action: 'stop', delegationId: 'd-1' }))
      .toMatchObject({ ok: true, call: { action: 'stop', delegationId: 'd-1' } });
  });

  it('delegate_existing 缺 candidateRef → ambiguous；缺 content → invalid_call', () => {
    expect(parseDelegateSessionCall({ action: 'delegate_existing', content: 'x' }))
      .toMatchObject({ ok: false, code: 'ambiguous' });
    expect(parseDelegateSessionCall({ action: 'delegate_existing', candidateRef: 'ref-1' }))
      .toMatchObject({ ok: false, code: 'invalid_call' });
  });

  it('参数不是对象 → invalid_call', () => {
    expect(parseDelegateSessionCall('nope')).toMatchObject({ ok: false, code: 'invalid_call' });
    expect(parseDelegateSessionCall(null)).toMatchObject({ ok: false, code: 'invalid_call' });
  });
});

describe('admitDelegation（G1-G12）', () => {
  it('基线快照全绿：admitted 且绑定解析出的目标', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot(),
    );
    expect(result).toMatchObject({ kind: 'admitted', targetSessionId: 'target-a' });
    expect(result.kind === 'admitted' && result.submissionKey).toMatch(/^sdk_[0-9a-f]{32}$/);
  });

  it('G1：目标缺失/归档/删除 → target_unavailable（真阳×3），健康目标通过（真阴）', () => {
    for (const patch of [
      { sessionExists: false },
      { isArchived: true },
      { isDeleted: true },
    ]) {
      const result = admitDelegation(
        parseOkCall(delegateExistingCall()),
        healthySnapshot({ target: { ...healthySnapshot().target, ...patch } }),
      );
      expect(result).toMatchObject({ kind: 'rejected', code: 'target_unavailable', gate: 'G1' });
    }
    expect(admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot(),
    )).toMatchObject({ kind: 'admitted' });
  });

  it('G2：非 chat 类型 → not_delegatable（真阳），chat 通过（真阴）', () => {
    const subagent = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({ target: { ...healthySnapshot().target, sessionType: 'subagent' } }),
    );
    expect(subagent).toMatchObject({ kind: 'rejected', code: 'not_delegatable', gate: 'G2' });
  });

  it('G2：未登记的新引擎 kind 名（cast）→ not_delegatable，判据是 !== native', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({
        target: { ...healthySnapshot().target, engineKind: 'brand_new_engine' as never },
      }),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'not_delegatable', gate: 'G2' });
  });

  it('G2：目标是发起会话自身 → self_route', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({
        originSessionId: 'target-a',
        target: { ...healthySnapshot().target, sessionId: 'target-a' },
      }),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'self_route', gate: 'G2' });
  });

  it('G3：candidateSetId 过期 → candidate_set_stale（真阳），当前集合通过（真阴）', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall({ candidateSetId: 'set-old' })),
      healthySnapshot(),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'candidate_set_stale', gate: 'G3' });
    expect(admitDelegation(
      parseOkCall(delegateExistingCall({ candidateSetId: 'set-current' })),
      healthySnapshot(),
    )).toMatchObject({ kind: 'admitted' });
  });

  it('G3：candidateRef 对不上 → ambiguous（真阳）', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall({ candidateRef: 'ref-elsewhere' })),
      healthySnapshot(),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'ambiguous', gate: 'G3' });
  });

  it('G3：宿主候选读失败（无 candidates 快照）→ ambiguous', () => {
    const snapshot = healthySnapshot();
    delete snapshot.candidates;
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      snapshot,
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'ambiguous' });
  });

  it('G4：同键同指纹 → reused；同键异指纹 → idempotency_conflict', () => {
    const call = parseOkCall(delegateExistingCall());
    const fingerprint = deriveActionFingerprint({
      action: 'delegate_existing',
      targetIdentity: 'session:target-a',
      content: 'do the thing',
      attachmentRefs: [],
    });
    const reused = admitDelegation(call, healthySnapshot({
      existingDelegation: {
        delegationId: 'd-1',
        originSessionId: 'origin-1',
        targetSessionId: 'target-a',
        actionFingerprint: fingerprint,
        status: 'active',
      },
    }));
    expect(reused).toMatchObject({ kind: 'reused', delegationId: 'd-1' });

    const conflict = admitDelegation(call, healthySnapshot({
      existingDelegation: {
        delegationId: 'd-1',
        originSessionId: 'origin-1',
        targetSessionId: 'target-a',
        actionFingerprint: '0'.repeat(64),
        status: 'active',
      },
    }));
    expect(conflict).toMatchObject({ kind: 'rejected', code: 'idempotency_conflict', gate: 'G4' });
  });

  it('G4 排在门首：目标已归档时幂等重试仍返回 reused', () => {
    const call = parseOkCall(delegateExistingCall());
    const fingerprint = deriveActionFingerprint({
      action: 'delegate_existing',
      targetIdentity: 'session:target-a',
      content: 'do the thing',
      attachmentRefs: [],
    });
    const result = admitDelegation(call, healthySnapshot({
      target: { ...healthySnapshot().target, isArchived: true },
      existingDelegation: {
        delegationId: 'd-1',
        originSessionId: 'origin-1',
        targetSessionId: 'target-a',
        actionFingerprint: fingerprint,
        status: 'active',
      },
    }));
    expect(result).toMatchObject({ kind: 'reused' });
  });

  it('G5：workspaceScope 不可解析/未授权 → workspace_boundary（真阳×2）', () => {
    for (const patch of [
      { workspaceRoot: null },
      { workspaceAuthorized: false },
    ]) {
      const result = admitDelegation(
        parseOkCall(delegateExistingCall()),
        healthySnapshot({ target: { ...healthySnapshot().target, ...patch } }),
      );
      expect(result).toMatchObject({ kind: 'rejected', code: 'workspace_boundary', gate: 'G5' });
    }
  });

  it('G6：其他会话轮与目标工作区重叠 → write_conflict（真阳）', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({
        runningTurns: [{ sessionId: 'user-session', workspaceRoot: '/ws/target-a/sub' }],
      }),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'write_conflict', gate: 'G6' });
  });

  it('G6：发起会话自身的轮不算写方（K1B 决策），不重叠路径也不算', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({
        runningTurns: [
          { sessionId: 'origin-1', workspaceRoot: '/ws/target-a' },
          { sessionId: 'target-a', workspaceRoot: '/ws/target-a' },
          { sessionId: 'user-session', workspaceRoot: '/elsewhere' },
        ],
      }),
    );
    expect(result).toMatchObject({ kind: 'admitted' });
  });

  it('G8：create_new 缺 host 受信工作区根 → unauthorized_workspace（真阳），带根通过（真阴）', () => {
    const createNew = parseOkCall({ action: 'create_new', content: '新活' });
    const noRoot = healthySnapshot();
    delete noRoot.hostWorkspaceRoot;
    expect(admitDelegation(createNew, noRoot))
      .toMatchObject({ kind: 'rejected', code: 'unauthorized_workspace', gate: 'G8' });

    const admitted = admitDelegation(createNew, healthySnapshot({
      target: {
        ...healthySnapshot().target,
        sessionId: null,
        sessionExists: false,
        permissionMode: null,
        workspaceRoot: '/authorized/root',
      },
    }));
    expect(admitted).toMatchObject({ kind: 'admitted', targetSessionId: null });
  });

  it('G10：用户活跃 run（对不上任何委托行）→ target_busy（真阳）', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({ targetActiveRunId: 'run-user' }),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'target_busy', gate: 'G10' });
  });

  it('G10：run id 对得上委托行的 target_run_id → 不拒（同目标多条委托排队）', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({ targetActiveRunId: 'run-delegated', delegatedRunIds: ['run-delegated'] }),
    );
    expect(result).toMatchObject({ kind: 'admitted' });
  });

  it('G10：目标上有用户来源 queued/sending 行 → target_busy', () => {
    const result = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({ userQueuedOrSendingRows: 2 }),
    );
    expect(result).toMatchObject({ kind: 'rejected', code: 'target_busy', gate: 'G10' });
  });

  it('G11：bypassPermissions / delegate / 未知档 → target_permission_mode（真阳×3）', () => {
    for (const mode of ['bypassPermissions', 'delegate', 'made-up-mode']) {
      const result = admitDelegation(
        parseOkCall(delegateExistingCall()),
        healthySnapshot({ target: { ...healthySnapshot().target, permissionMode: mode } }),
      );
      expect(result).toMatchObject({ kind: 'rejected', code: 'target_permission_mode', gate: 'G11' });
    }
  });

  it('G11：default/readOnly/acceptEdits/dontAsk/plan 全通过（真阴×5）', () => {
    for (const mode of ['default', 'readOnly', 'acceptEdits', 'dontAsk', 'plan']) {
      const result = admitDelegation(
        parseOkCall(delegateExistingCall()),
        healthySnapshot({ target: { ...healthySnapshot().target, permissionMode: mode } }),
      );
      expect(result).toMatchObject({ kind: 'admitted' });
    }
  });

  it('G12：评估缺失/抛错形状 → untrusted_workspace（真阳×2）', () => {
    for (const folderTrust of [null, { error: true }] as DelegationFolderTrustFact[]) {
      const result = admitDelegation(
        parseOkCall(delegateExistingCall()),
        healthySnapshot({ target: { ...healthySnapshot().target, folderTrust } }),
      );
      expect(result).toMatchObject({ kind: 'rejected', code: 'untrusted_workspace', gate: 'G12' });
    }
  });

  it('G12：非 trusted 且 blockedItems>0 → untrusted_workspace；blocked=0 不拒', () => {
    const blocked = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({
        target: { ...healthySnapshot().target, folderTrust: { state: 'blocked', blockedItems: 2 } },
      }),
    );
    expect(blocked).toMatchObject({ kind: 'rejected', code: 'untrusted_workspace', gate: 'G12' });

    const clean = admitDelegation(
      parseOkCall(delegateExistingCall()),
      healthySnapshot({
        target: { ...healthySnapshot().target, folderTrust: { state: 'blocked', blockedItems: 0 } },
      }),
    );
    expect(clean).toMatchObject({ kind: 'admitted' });
  });

  it('任何拒绝路径都不产出 create_new 或绑定任意会话', () => {
    const rejectionSnapshots: DelegationAdmissionSnapshot[] = [
      healthySnapshot({ target: { ...healthySnapshot().target, isArchived: true } }),
      healthySnapshot({ target: { ...healthySnapshot().target, engineKind: 'grok_cli' } }),
      healthySnapshot({ target: { ...healthySnapshot().target, workspaceRoot: null } }),
      healthySnapshot({ runningTurns: [{ sessionId: 'other', workspaceRoot: '/ws/target-a' }] }),
      healthySnapshot({ targetActiveRunId: 'run-user' }),
      healthySnapshot({ userQueuedOrSendingRows: 1 }),
      healthySnapshot({ target: { ...healthySnapshot().target, permissionMode: 'bypassPermissions' } }),
      healthySnapshot({ target: { ...healthySnapshot().target, folderTrust: null } }),
    ];
    const call = parseOkCall(delegateExistingCall());
    for (const snapshot of rejectionSnapshots) {
      const result = admitDelegation(call, snapshot);
      expect(result.kind).toBe('rejected');
    }
    // create_new 自己的拒绝路径（G8：无 host 受信根）同样不产出绑定。
    const noRoot = healthySnapshot();
    delete noRoot.hostWorkspaceRoot;
    const createNew = parseOkCall({ action: 'create_new', content: 'x' });
    expect(admitDelegation(createNew, noRoot)).toMatchObject({ kind: 'rejected' });
    const admitted = admitDelegation(createNew, healthySnapshot({
      target: { ...healthySnapshot().target, sessionId: null, sessionExists: false, permissionMode: null },
    }));
    expect(admitted).toMatchObject({ kind: 'admitted', targetSessionId: null });
  });
});

describe('admitDelegation（链上操作 correct/stop/resume）', () => {
  const stopCall = { action: 'stop' as const, delegationId: 'd-1' };

  it('委托行不存在 / origin 对不上 → invalid_call（真阳×2）', () => {
    expect(admitDelegation(stopCall, healthySnapshot()))
      .toMatchObject({ kind: 'rejected', code: 'invalid_call' });
    expect(admitDelegation(stopCall, healthySnapshot({
      chainDelegation: {
        delegationId: 'd-1',
        originSessionId: 'someone-else',
        targetSessionId: 'target-a',
        status: 'active',
      },
    }))).toMatchObject({ kind: 'rejected', code: 'invalid_call' });
  });

  it('stop+active 与 resume+stopped 通过；状态不符 → invalid_call（真阳×2）', () => {
    const activeRow = {
      delegationId: 'd-1',
      originSessionId: 'origin-1',
      targetSessionId: 'target-a',
      status: 'active',
    };
    expect(admitDelegation(stopCall, healthySnapshot({ chainDelegation: activeRow })))
      .toMatchObject({ kind: 'admitted', targetSessionId: 'target-a', delegationId: 'd-1' });
    expect(admitDelegation(
      { action: 'resume', delegationId: 'd-1' },
      healthySnapshot({ chainDelegation: { ...activeRow, status: 'stopped' } }),
    )).toMatchObject({ kind: 'admitted' });

    expect(admitDelegation(stopCall, healthySnapshot({ chainDelegation: { ...activeRow, status: 'stopped' } })))
      .toMatchObject({ kind: 'rejected', code: 'invalid_call' });
    expect(admitDelegation(
      { action: 'resume', delegationId: 'd-1' },
      healthySnapshot({ chainDelegation: activeRow }),
    )).toMatchObject({ kind: 'rejected', code: 'invalid_call' });
  });

  it('correct 需要 active；aborted → invalid_call（真阳）', () => {
    const activeRow = {
      delegationId: 'd-1',
      originSessionId: 'origin-1',
      targetSessionId: 'target-a',
      status: 'active',
    };
    expect(admitDelegation(
      { action: 'correct', delegationId: 'd-1' },
      healthySnapshot({ chainDelegation: activeRow }),
    )).toMatchObject({ kind: 'admitted' });
    expect(admitDelegation(
      { action: 'correct', delegationId: 'd-1' },
      healthySnapshot({ chainDelegation: { ...activeRow, status: 'aborted' } }),
    )).toMatchObject({ kind: 'rejected', code: 'invalid_call' });
  });

  it('correct/resume 复跑 G1/G2/G11/G12：归档与 bypassPermissions 都拒', () => {
    const stoppedRow = {
      delegationId: 'd-1',
      originSessionId: 'origin-1',
      targetSessionId: 'target-a',
      status: 'stopped',
    };
    expect(admitDelegation(
      { action: 'resume', delegationId: 'd-1' },
      healthySnapshot({
        chainDelegation: stoppedRow,
        target: { ...healthySnapshot().target, isArchived: true },
      }),
    )).toMatchObject({ kind: 'rejected', code: 'target_unavailable', gate: 'G1' });
    expect(admitDelegation(
      { action: 'correct', delegationId: 'd-1' },
      healthySnapshot({
        chainDelegation: { ...stoppedRow, status: 'active' },
        target: { ...healthySnapshot().target, permissionMode: 'bypassPermissions' },
      }),
    )).toMatchObject({ kind: 'rejected', code: 'target_permission_mode', gate: 'G11' });
  });
});

describe('recheckForDelivery（INV-2 三句 + G1/G2/G11/G12）', () => {
  function deliverySnapshot(
    overrides: Partial<DelegationDeliverySnapshot> = {},
  ): DelegationDeliverySnapshot {
    return {
      target: { ...healthySnapshot().target },
      originSessionId: 'origin-1',
      activeRunId: null,
      delegatedRunIds: [],
      userRowsAhead: 0,
      ...overrides,
    };
  }

  it('空闲且无前置用户行 → deliver', () => {
    expect(recheckForDelivery(deliverySnapshot())).toEqual({ kind: 'deliver' });
  });

  it('另一条委托占着的 run（id 对上其 target_run_id）→ wait 而非 pause', () => {
    expect(recheckForDelivery(deliverySnapshot({
      activeRunId: 'run-delegation-a',
      delegatedRunIds: ['run-delegation-a', 'run-delegation-b'],
    }))).toEqual({ kind: 'wait' });
  });

  it('对不上任何委托行的活跃 run → pause target_busy', () => {
    expect(recheckForDelivery(deliverySnapshot({ activeRunId: 'run-user' })))
      .toMatchObject({ kind: 'pause', code: 'target_busy' });
  });

  it('排在本行之前的用户来源可投/发送中行 → pause target_busy', () => {
    expect(recheckForDelivery(deliverySnapshot({ userRowsAhead: 1 })))
      .toMatchObject({ kind: 'pause', code: 'target_busy' });
  });

  it('排在本行之后的输入不算忙：复核只看 userRowsAhead，G 门全绿时即 deliver', () => {
    // 「之后的行」不进快照（collectDeliveryFacts 只数之前的行），这里钉住字段语义：
    // userRowsAhead=0 且无活跃 run 时，无论队尾还有多少行，结论都是 deliver。
    expect(recheckForDelivery(deliverySnapshot({ userRowsAhead: 0 }))).toEqual({ kind: 'deliver' });
  });

  it('复核侧 G1/G2/G11/G12 红各自 pause 对应码', () => {
    expect(recheckForDelivery(deliverySnapshot({
      target: { ...healthySnapshot().target, isDeleted: true },
    }))).toMatchObject({ kind: 'pause', code: 'target_unavailable' });
    expect(recheckForDelivery(deliverySnapshot({
      target: { ...healthySnapshot().target, engineKind: 'codex_cli' },
    }))).toMatchObject({ kind: 'pause', code: 'not_delegatable' });
    expect(recheckForDelivery(deliverySnapshot({
      target: { ...healthySnapshot().target, permissionMode: 'bypassPermissions' },
    }))).toMatchObject({ kind: 'pause', code: 'target_permission_mode' });
    expect(recheckForDelivery(deliverySnapshot({
      target: { ...healthySnapshot().target, folderTrust: { error: true } },
    }))).toMatchObject({ kind: 'pause', code: 'untrusted_workspace' });
  });
});

describe('workspacesOverlap（G6 判据）', () => {
  it('相等与带分隔符前缀都算重叠，兄弟目录不算', () => {
    expect(workspacesOverlap('/ws/a', '/ws/a')).toBe(true);
    expect(workspacesOverlap('/ws/a', '/ws/a/sub')).toBe(true);
    expect(workspacesOverlap('/ws/a/sub', '/ws/a')).toBe(true);
    expect(workspacesOverlap('/ws/a', '/ws/ab')).toBe(false);
    expect(workspacesOverlap('/ws/a', null)).toBe(false);
  });
});
