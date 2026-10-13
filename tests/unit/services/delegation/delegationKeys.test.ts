import { createHash } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import {
  attachmentRefsOf,
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
    expect(key.startsWith('sdk_')).toBe(true);
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

  it('attachmentRefsOf 只收 id/path，缺 id 的条目丢弃', () => {
    expect(attachmentRefsOf([
      { id: 'att-1', path: '/tmp/a.png' },
      { path: '/tmp/no-id.png' },
      'not-an-object',
    ] as never)).toEqual([{ id: 'att-1', path: '/tmp/a.png' }]);
    expect(attachmentRefsOf(undefined)).toEqual([]);
  });
});

describe('delegationKeys 金向量（D5 字节级公式，字面量钉死）', () => {
  // 期望值是按 ADR-072 D5 公式手工预计算的常量，不经过被测代码：
  // 分隔符、字段顺序、canonical JSON 布局、截断长度任一漂移都会在这里先红。

  it('submissionKey = sdk_ + sha256(origin\\0turn\\0action\\0targetIdentity) 前 32 hex', () => {
    expect(deriveSubmissionKey({
      originSessionId: 'origin-1',
      originTurnId: 'turn-1',
      action: 'delegate_existing',
      targetIdentity: 'session:target-1',
    })).toBe('sdk_31c317a16a8c081b7d35d382fb0dab59');
    // 换一个字段（turn）→ 不同摘要：字段真的进了哈希。
    expect(deriveSubmissionKey({
      originSessionId: 'origin-1',
      originTurnId: 'turn-2',
      action: 'delegate_existing',
      targetIdentity: 'session:target-1',
    })).not.toBe('sdk_31c317a16a8c081b7d35d382fb0dab59');
  });

  it('fingerprint = sha256(action\\0targetIdentity\\0canonicalJson)，对象键按字典序（字面量×3）', () => {
    // 无附件：canonical 载荷 = {"attachmentRefs":[],"content":"do the thing"}
    expect(deriveActionFingerprint({
      action: 'delegate_existing',
      targetIdentity: 'session:target-1',
      content: 'do the thing',
      attachmentRefs: [],
    })).toBe('c6d44794290ad55c40b8720c94dbdce6fbbeb779f2672b26d9fae47f95527041');

    // 带附件（乱序传入）+ 非 ASCII 正文：canonical 载荷里附件按 id 再 path 排好序，
    // 即 {"attachmentRefs":[{"id":"att-1","path":"/tmp/a.png"},{"id":"att-2","path":null}],"content":"第一版正文"}
    expect(deriveActionFingerprint({
      action: 'delegate_existing',
      targetIdentity: 'session:target-1',
      content: '第一版正文',
      attachmentRefs: [
        { id: 'att-2', path: null },
        { id: 'att-1', path: '/tmp/a.png' },
      ],
    })).toBe('416fad570c3fda20d16f6e0c5a4bc7f68994413c7d70e7c2ec143b95d9acf452');

    // 链上操作身份 + 空正文。
    expect(deriveActionFingerprint({
      action: 'stop',
      targetIdentity: 'delegation:d-1',
      content: '',
      attachmentRefs: [],
    })).toBe('9276caf42d9a054f710bbc74e53715210ba3f2db62ac796effe21723d08b410f');
  });

  it('金向量与测试内独立重算一致（红的时候能区分公式漂移与字面量抄错）', () => {
    const sha256 = (value: string) => createHash('sha256').update(value, 'utf8').digest('hex');
    const canonical = '{"attachmentRefs":[],"content":"do the thing"}';
    expect(deriveActionFingerprint({
      action: 'delegate_existing',
      targetIdentity: 'session:target-1',
      content: 'do the thing',
      attachmentRefs: [],
    })).toBe(sha256(`delegate_existing\0session:target-1\0${canonical}`));
  });
});
