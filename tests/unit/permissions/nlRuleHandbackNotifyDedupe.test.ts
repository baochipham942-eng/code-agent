// ============================================================================
// 同一条 handback 停车步骤只出一条 needs-input 横幅，且是 handback 文案
// （N-PERM-NL-RULES-K2 r3）
// ----------------------------------------------------------------------------
// 真实 NotificationService（dry-run 只记录）：停车口先发 handback 文案（dedupeKey=行 id），
// 事件落库口随后发通用「需要授权」同键 → 被去重。现场曾在同一毫秒记下两条。
// ============================================================================

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { NL_RULE_K2_TEXT } from '../../../src/shared/nlRuleRestate';

describe('handback 停车通知去重', () => {
  beforeEach(() => {
    vi.stubEnv('CODE_AGENT_NOTIFICATION_DRY_RUN', '1');
    vi.resetModules();
  });
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it('停车口（handback）先发、事件口（需要授权）同键后发 → 只记录一条，是 handback 文案', async () => {
    const { notificationService } = await import('../../../src/host/services/infra/notificationService');
    notificationService.clearRecentNotifications();
    const requestId = 'perm-handback-1';
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: NL_RULE_K2_TEXT.notify.title,
      body: NL_RULE_K2_TEXT.notify.body('Bash'),
      dedupeKey: requestId,
    });
    notificationService.notifyNeedsInput({
      sessionId: 's1',
      title: '需要授权',
      body: 'Bash: rm /tmp/x',
      dedupeKey: requestId,
    });
    const recorded = notificationService.getRecentNotifications().filter((n) => n.type === 'needs_input');
    expect(recorded).toHaveLength(1);
    expect(recorded[0].title).toBe(NL_RULE_K2_TEXT.notify.title);
    expect(recorded[0].body).toBe(NL_RULE_K2_TEXT.notify.body('Bash'));
  });
});
