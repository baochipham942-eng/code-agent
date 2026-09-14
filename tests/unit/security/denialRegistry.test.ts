// ============================================================================
// ADR-067 刀 3：denialRegistry 单元测试
// 指纹规范化（同义同指纹 / 异形不同指纹 / 不可解析不登记）+ (sessionId, 指纹) 键
// + 容量有界（每 session FIFO 50 / 20 sessions）+ ask-approved 复位
// ============================================================================

import { beforeEach, describe, expect, it } from 'vitest';
import {
  computeActionFingerprint,
  getDenialRegistry,
  resetDenialRegistry,
  type DenialRecord,
} from '../../../src/host/security/denialRegistry';

const CWD = '/tmp/work';

function entry(sessionId: string, fingerprint: string, index = 0): DenialRecord {
  return {
    sessionId,
    fingerprint,
    toolName: 'Bash',
    summary: fingerprint,
    reason: 'user',
    timestamp: 1000 + index,
  };
}

describe('computeActionFingerprint（指纹规范化真源复用）', () => {
  it('bash：引号/空白等同义改写同指纹（canonicalizeCommand 唯一文本形）', () => {
    const bare = computeActionFingerprint('Bash', { command: "find . -name dummy.tmp -delete" }, CWD);
    const quoted = computeActionFingerprint('Bash', { command: "find . -name 'dummy.tmp' -delete" }, CWD);
    const spaced = computeActionFingerprint('Bash', { command: 'find   .  -name   dummy.tmp   -delete' }, CWD);
    expect(bare).toBeTruthy();
    expect(quoted).toBe(bare);
    expect(spaced).toBe(bare);
  });

  it('bash：改参异形不同指纹（误伤边界）', () => {
    const a = computeActionFingerprint('Bash', { command: 'find . -name a.tmp -delete' }, CWD);
    const b = computeActionFingerprint('Bash', { command: 'find . -name b.tmp -delete' }, CWD);
    expect(a).not.toBe(b);
  });

  it('bash：静态不可解析（命令替换）不登记——该路径本就 agent 无关地 fail-closed', () => {
    expect(computeActionFingerprint('Bash', { command: 'rm -rf $(pwd)' }, CWD)).toBeNull();
  });

  it('文件路径类：cwd 归一；不同工具不同指纹', () => {
    const write = computeActionFingerprint('Write', { file_path: 'out.txt' }, CWD);
    const edit = computeActionFingerprint('Edit', { file_path: 'out.txt' }, CWD);
    expect(write).toBe(`file:Write:${CWD}/out.txt`);
    expect(edit).toBe(`file:Edit:${CWD}/out.txt`);
    expect(write).not.toBe(edit);
  });

  it('external 出站：复用 standingGrantTarget 收件人集合规范化', () => {
    const fingerprint = computeActionFingerprint('mail_send', {
      to: ['boss@example.com'],
      cc: ['team@example.com'],
      subject: 'x',
    }, CWD);
    expect(fingerprint).toContain('external:mail_send:');
    expect(fingerprint).toContain('boss@example.com');
    expect(fingerprint).toContain('team@example.com');
    // 收件人不同 → 指纹不同（bcc 加人 = 另一动作，必重新审批的同口径）
    const widened = computeActionFingerprint('mail_send', {
      to: ['boss@example.com'],
      bcc: ['outsider@example.com'],
    }, CWD);
    expect(widened).not.toBe(fingerprint);
  });

  it('无法规范化的工具形状返回 null', () => {
    expect(computeActionFingerprint('some_custom_tool', { foo: 1 }, CWD)).toBeNull();
  });
});

describe('DenialRegistry（(sessionId, 指纹) 键与容量有界）', () => {
  beforeEach(() => resetDenialRegistry());

  it('同 session 命中，跨 session 不共享', () => {
    const registry = getDenialRegistry();
    registry.record(entry('s1', 'fp-1'));
    expect(registry.find('s1', 'fp-1')).toBeTruthy();
    expect(registry.find('s2', 'fp-1')).toBeUndefined();
  });

  it('clear（ask-approved 复位）后不再命中；bucket 空则 session 移除', () => {
    const registry = getDenialRegistry();
    registry.record(entry('s1', 'fp-1'));
    registry.clear('s1', 'fp-1');
    expect(registry.find('s1', 'fp-1')).toBeUndefined();
  });

  it('每 session FIFO 50：溢出逐最旧，最新仍命中', () => {
    const registry = getDenialRegistry();
    for (let i = 0; i < 60; i += 1) {
      registry.record(entry('s1', `fp-${i}`, i));
    }
    expect(registry.find('s1', 'fp-0')).toBeUndefined();
    expect(registry.find('s1', 'fp-9')).toBeUndefined();
    expect(registry.find('s1', 'fp-10')).toBeTruthy();
    expect(registry.find('s1', 'fp-59')).toBeTruthy();
  });

  it('同指纹重插刷新 FIFO 序（最新一条有效）', () => {
    const registry = getDenialRegistry();
    for (let i = 0; i < 50; i += 1) {
      registry.record(entry('s1', `fp-${i}`, i));
    }
    registry.record(entry('s1', 'fp-0', 999));
    for (let i = 50; i < 60; i += 1) {
      registry.record(entry('s1', `fp-${i}`, i));
    }
    // fp-0 被重插到最新，不再是最旧——fp-1 才是该被逐出的
    expect(registry.find('s1', 'fp-0')).toBeTruthy();
    expect(registry.find('s1', 'fp-1')).toBeUndefined();
  });

  it('session 表 FIFO 20：跨 session 内存有界', () => {
    const registry = getDenialRegistry();
    for (let i = 0; i < 25; i += 1) {
      registry.record(entry(`s${i}`, 'fp', i));
    }
    expect(registry.find('s0', 'fp')).toBeUndefined();
    expect(registry.find('s4', 'fp')).toBeUndefined();
    expect(registry.find('s5', 'fp')).toBeTruthy();
    expect(registry.find('s24', 'fp')).toBeTruthy();
  });
});
