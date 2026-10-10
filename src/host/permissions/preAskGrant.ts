// ============================================================================
// 问用户之前的授权消费：先按应用，再按既有 external 长期授权。
// 硬门（blocked）一律不消费。分类器 deny 在调用方更早返回，这里碰不到。
// ============================================================================

import { getSessionAutomationService } from '../services/sessionAutomation/sessionAutomationService';
import { matchAppGrant } from './appGrantStore';
import { appGrantKey, type ComputerTargetApp } from './computerAppTarget';

export function resolvePreAskGrant(input: {
  toolName: string;
  sessionId: string | undefined;
  standingGrantTarget: string | null;
  computerApp: ComputerTargetApp | null;
  blocked: boolean;
}): { ledgerReason: string; traceRule: string; traceDetail: string } | null {
  if (input.blocked) return null;
  if (input.computerApp && matchAppGrant(input.sessionId ?? '', input.computerApp)) {
    return {
      ledgerReason: `app_grant:${appGrantKey(input.computerApp)}`,
      traceRule: 'app_grant',
      traceDetail: `app grant hit: ${input.computerApp.name}`,
    };
  }
  if (!input.standingGrantTarget) return null;
  const hit = getSessionAutomationService().matchStandingGrant(
    input.sessionId,
    input.toolName,
    input.standingGrantTarget,
  );
  if (!hit) return null;
  return {
    ledgerReason: `standing_grant:${input.standingGrantTarget}`,
    traceRule: 'standing_grant',
    traceDetail: `长期授权命中：${input.toolName} → ${input.standingGrantTarget}`,
  };
}
