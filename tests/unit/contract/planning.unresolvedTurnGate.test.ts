import { describe, expect, it } from 'vitest';
import {
  applyUnresolvedTaskTurnGate,
  formatUnresolvedTaskLine,
  formatUnresolvedTaskList,
  isUnresolvedTurnTaskStatus,
  statusRequiresWaitReason,
  validateTaskStatusEvidence,
  type SessionTaskStatus,
} from '../../../src/shared/contract/planning';

describe('unresolved turn task helpers', () => {
  it('classifies wait/blocked/in_progress as unresolved, completed as closed', () => {
    expect(isUnresolvedTurnTaskStatus('needs_decision')).toBe(true);
    expect(isUnresolvedTurnTaskStatus('user_action')).toBe(true);
    expect(isUnresolvedTurnTaskStatus('blocked')).toBe(true);
    expect(isUnresolvedTurnTaskStatus('in_progress')).toBe(true);
    expect(isUnresolvedTurnTaskStatus('pending')).toBe(false);
    expect(isUnresolvedTurnTaskStatus('completed')).toBe(false);
    expect(isUnresolvedTurnTaskStatus('cancelled')).toBe(false);
  });

  it('requires a wait reason for blocked, needs_decision, and user_action', () => {
    expect(statusRequiresWaitReason('blocked')).toBe(true);
    expect(statusRequiresWaitReason('needs_decision')).toBe(true);
    expect(statusRequiresWaitReason('user_action')).toBe(true);
    expect(statusRequiresWaitReason('in_progress')).toBe(false);
    expect(validateTaskStatusEvidence('needs_decision', {})).toContain('blockedReason');
    expect(validateTaskStatusEvidence('user_action', {})).toContain('blockedReason');
    expect(validateTaskStatusEvidence('needs_decision', { blockedReason: '在 A/B 间选' })).toBeNull();
  });

  it('formats who is waiting and for what', () => {
    expect(formatUnresolvedTaskLine({
      id: '1',
      subject: '选择酒店方案',
      status: 'needs_decision',
      blockedReason: '在两家酒店间选',
    })).toBe('#1 选择酒店方案 — 等你拍板：在两家酒店间选');
    expect(formatUnresolvedTaskLine({
      id: '2',
      subject: '完成线下签字',
      status: 'user_action',
      owner: 'user',
      blockedReason: '合同要本人签字',
    })).toBe('#2 完成线下签字 @user — 等你操作：合同要本人签字');
    expect(formatUnresolvedTaskList([
      { id: '1', subject: '选择酒店方案', status: 'needs_decision', blockedReason: '在两家酒店间选' },
    ])).toContain('等你拍板');
  });

  it('downgrades verified when unresolved tasks remain and keeps the wait list', () => {
    const gated = applyUnresolvedTaskTurnGate('verified', [], [{
      id: '1',
      subject: '选择酒店方案',
      status: 'needs_decision',
      blockedReason: '在两家酒店间选',
    }]);
    expect(gated.verdict).toBe('self_claimed');
    expect(gated.evidenceProblems.join('\n')).toContain('UNRESOLVED_TASKS');
    expect(gated.evidenceProblems.join('\n')).toContain('选择酒店方案');
    expect(gated.evidenceProblems.join('\n')).toContain('等你拍板');
  });

  it('leaves verified alone when every explicit task is closed', () => {
    const gated = applyUnresolvedTaskTurnGate('verified', [], []);
    expect(gated.verdict).toBe('verified');
    expect(gated.evidenceProblems).toEqual([]);
  });

  it('does not invent a wait label for an unknown status at compile time', () => {
    const statuses: SessionTaskStatus[] = [
      'pending', 'in_progress', 'completed', 'blocked', 'cancelled', 'needs_decision', 'user_action',
    ];
    expect(statuses).toHaveLength(7);
  });
});
