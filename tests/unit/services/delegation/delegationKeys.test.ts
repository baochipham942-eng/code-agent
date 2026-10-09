import { describe, expect, it } from 'vitest';

import {
  SUBMISSION_KEY_PREFIX,
  attachmentRefsOf,
  canonicalJson,
  deriveActionFingerprint,
  deriveSubmissionKey,
  delegationTargetIdentity,
} from '../../../../src/host/services/delegation/delegationKeys';

describe('delegationKeys', () => {
  it('同输入逐字节同输出（submissionKey 与 fingerprint 都确定性）', () => {
    const input = {
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      action: 'delegate_existing' as const,
      targetIdentity: 'session:target-1',
    };
    expect(deriveSubmissionKey(input)).toBe(deriveSubmissionKey(input));

    const payload = {
      action: 'delegate_existing' as const,
      targetIdentity: 'session:target-1',
      content: 'do the thing',
      attachmentRefs: [{ id: 'att-1', path: '/tmp/a.png' }],
    };
    expect(deriveActionFingerprint(payload)).toBe(deriveActionFingerprint(payload));
  });

  it('submissionKey 带 sdk_ 前缀且取 32 hex', () => {
    const key = deriveSubmissionKey({
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      action: 'delegate_existing',
      targetIdentity: 'session:target-1',
    });
    expect(key.startsWith(SUBMISSION_KEY_PREFIX)).toBe(true);
    expect(key).toMatch(/^sdk_[0-9a-f]{32}$/);
  });

  it('targetIdentity 三种形态：session / new / delegation', () => {
    expect(delegationTargetIdentity({ action: 'delegate_existing', sessionId: 's-1' }))
      .toBe('session:s-1');
    expect(delegationTargetIdentity({ action: 'create_new', hostWorkspaceRoot: '/w/root' }))
      .toBe('new:/w/root');
    expect(delegationTargetIdentity({ action: 'stop', delegationId: 'd-1' }))
      .toBe('delegation:d-1');
  });

  it('同发起轮同目标改正文：同 key 不同 fingerprint', () => {
    const keyInput = {
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      action: 'delegate_existing' as const,
      targetIdentity: 'session:target-1',
    };
    const firstKey = deriveSubmissionKey(keyInput);
    const secondKey = deriveSubmissionKey({ ...keyInput, originTurnId: 'turn-2' });

    expect(deriveSubmissionKey(keyInput)).toBe(firstKey);
    expect(secondKey).not.toBe(firstKey);

    const base = {
      action: 'delegate_existing' as const,
      targetIdentity: 'session:target-1',
    };
    const fp1 = deriveActionFingerprint({ ...base, content: '第一版正文', attachmentRefs: [] });
    const fp2 = deriveActionFingerprint({ ...base, content: '改过的正文', attachmentRefs: [] });
    expect(fp1).not.toBe(fp2);
    expect(fp1).toHaveLength(64);
  });

  it('载荷指纹覆盖 content 与附件引用（id/路径），附件顺序无关', () => {
    const base = {
      action: 'delegate_existing' as const,
      targetIdentity: 'session:target-1',
      content: '正文',
    };
    const noAttachments = deriveActionFingerprint({ ...base, attachmentRefs: [] });
    const withAttachment = deriveActionFingerprint({
      ...base,
      attachmentRefs: [{ id: 'att-1', path: '/tmp/a.png' }],
    });
    const differentPath = deriveActionFingerprint({
      ...base,
      attachmentRefs: [{ id: 'att-1', path: '/tmp/b.png' }],
    });
    const differentId = deriveActionFingerprint({
      ...base,
      attachmentRefs: [{ id: 'att-2', path: '/tmp/a.png' }],
    });
    expect(withAttachment).not.toBe(noAttachments);
    expect(differentPath).not.toBe(withAttachment);
    expect(differentId).not.toBe(withAttachment);

    const orderOne = deriveActionFingerprint({
      ...base,
      attachmentRefs: [
        { id: 'att-1', path: '/tmp/a.png' },
        { id: 'att-2', path: null },
      ],
    });
    const orderTwo = deriveActionFingerprint({
      ...base,
      attachmentRefs: [
        { id: 'att-2', path: null },
        { id: 'att-1', path: '/tmp/a.png' },
      ],
    });
    expect(orderOne).toBe(orderTwo);
  });

  it('canonicalJson 键排序且无空白，嵌套对象同样排序', () => {
    expect(canonicalJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}');
    expect(canonicalJson({ z: { d: 1, c: 2 }, a: [3, { y: 1, x: 2 }] }))
      .toBe('{"a":[3,{"x":2,"y":1}],"z":{"c":2,"d":1}}');
    expect(canonicalJson(undefined)).toBe('null');
  });

  it('attachmentRefsOf 只收 id/path，缺 id 的条目丢弃', () => {
    expect(attachmentRefsOf([
      { id: 'att-1', path: '/tmp/a.png' },
      { path: '/tmp/no-id.png' },
      'not-an-object',
    ] as never)).toEqual([{ id: 'att-1', path: '/tmp/a.png' }]);
    expect(attachmentRefsOf(undefined)).toEqual([]);
  });
});
